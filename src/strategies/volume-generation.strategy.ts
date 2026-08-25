import { createExchangeService } from '../services/exchange.factory';
import { ExchangeService, Order, Trade } from '../services/exchange.types';
import { getEPWXPairInfo } from '../utils/exchange-info';
import { logger } from '../utils/logger';
import { config } from '../config';
import { fetchEpwXPriceFromPancake } from '../utils/dex-price';
import { quantizeToStepSize } from '../utils/quantize';
import fs from 'fs';
import path from 'path';
// If you see errors about NodeJS.Timeout, setTimeout, etc., run: npm install --save-dev @types/node

interface VolumeStats {
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  orderCount: number;
  startTime: number;
  lastOrderTime: number;
}

interface ProfitStats {
  realFills: number; // Count of orders filled by real users
  washTrades: number; // Count of self-executed wash trades
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  realFillRealizedPnl: number;
  averageRealizedPnlPerRealFill: number;
  bestRealizedFillPnl: number;
  estimatedDailyRealizedPnl: number;
  inventoryQuantity: number;
  inventoryCostBasisUsd: number;
  inventoryMarkPrice: number;
}

interface PersistentRuntimeState {
  version: number;
  savedAt: number;
  volumeStats: Pick<VolumeStats, 'totalVolume' | 'buyVolume' | 'sellVolume' | 'orderCount' | 'startTime'>;
  profitStats: ProfitStats;
  realBuyFills: number;
  realSellFills: number;
  lifetimeBaselineEpwx: number | null;
  lifetimeBaselineUsdt: number | null;
  latestEpwxTotal: number | null;
  latestUsdtTotal: number | null;
}

type PlacementPriceSource = 'EXECUTABLE_BOOK_MID' | 'CEX_TICKER_MID' | 'DEX_FALLBACK';
type BuyReactivationMode = 'off' | 'auto' | 'on';
type SelfTradeMode = 'off' | 'on' | 'auto';
type CompletedOrderResolution = 'FILLED' | 'NO_FILL' | 'UNRESOLVED';

/**
 * Volume Generation Strategy
 * Generates trading volume on Biconomy Exchange using zero-fee MM account
 */
export class VolumeGenerationStrategy {
  private static readonly MIN_ORDER_NOTIONAL_USD = 5.01;
  private static readonly EXECUTABLE_DEPTH_BAND_PERCENT = 0.003;
  private static readonly SELL_IMBALANCE_GUARD_MIN_GAP = 3;
  private static readonly SELL_IMBALANCE_GUARD_MIN_RATIO = 1.8;
  private static readonly ADVERSE_BUY_FILL_GUARD_MIN_REAL_BUY_FILLS = 3;
  private static readonly ADVERSE_BUY_FILL_GUARD_MIN_GAP = 2;
  private static readonly ADVERSE_BUY_FILL_GUARD_MIN_RATIO = 1.6;
  private static readonly ADVERSE_BUY_FILL_GUARD_INVENTORY_DEPTH_MULTIPLIER = 1.25;
  private static readonly ADVERSE_BUY_FILL_GUARD_MIN_INVENTORY_USD = 25;
  private static readonly MAX_EXECUTABLE_SPREAD_PERCENT = 5;
  private static readonly MAX_CLAMP_REPRICE_RATIO = 1.5;
    public getProfitStats(): ProfitStats {
      return this.profitStats;
    }
  // Track active wash trade pairs for fill detection
  protected washTradePairsActive: Array<{ buyOrderId: string, sellOrderId: string, price: number, amount: number }> = [];
  static readonly DEX_PROVIDER_URL = 'https://mainnet.base.org';
  static readonly DEX_PAIR_ADDRESS = '0x8c4fe7dd7f57c8da00ec0766a4767dacdab47bc8';
  static readonly EPWX_ADDRESS = '0xef5f5751cf3eca6cc3572768298b7783d33d60eb';
  protected exchange: ExchangeService;
  private isRunning: boolean = false;
  private stepSize: number = 1;
  private tickSize: number = 1e-13;
  private minQty: number = 1;
  private symbol: string;
  private volumeStats: VolumeStats;
  protected profitStats: ProfitStats;
  private activeOrders: Map<string, Order> = new Map();
  private orderPrices: Map<string, { side: string; price: number }> = new Map(); // Track original order prices for profit calculation
  private processedTradeIds: Set<string> = new Set();
  private positionAdjustedOrderIds: Set<string> = new Set();
  private settledWashOrderIds: Set<string> = new Set();
  private pnlSettledOrderIds: Set<string> = new Set();
  private reconcilingCompletedOrderIds: Set<string> = new Set();
  private updateTimer?: NodeJS.Timeout;
  private orderTimer?: NodeJS.Timeout;
  private initialEpwxBalance: number | null = null;
  private currentPosition: number = 0;
  private orderStatusIndex: number = 0;
  private isPlacingOrders: boolean = false;
  private lastPerformanceLogAt: number = 0;
  private noFillDiagnosticsThisCycle: number = 0;
  private rebalanceInProgress: boolean = false;
  private lastRebalanceAt: number = 0;
  private realBuyFills: number = 0;
  private realSellFills: number = 0;
  private lastRealFillAt: number = Date.now();
  private washAutoCooldownUntil: number = 0;
  private washAutoEnabled: boolean = false;
  private readonly runtimeStatePath: string;
  private latestEpwxTotal: number | null = null;
  private latestUsdtTotal: number | null = null;
  private lifetimeBaselineEpwx: number | null = null;
  private lifetimeBaselineUsdt: number | null = null;
  private lastStatePersistAt: number = 0;

  constructor(exchange?: ExchangeService) {
    this.exchange = exchange || createExchangeService();
    this.symbol = config.trading.pair;
    this.runtimeStatePath = path.isAbsolute(config.runtime.stateFile)
      ? config.runtime.stateFile
      : path.resolve(process.cwd(), config.runtime.stateFile);
    this.volumeStats = this.initializeStats();
    this.profitStats = this.initializeProfitStats();
    this.loadPersistentRuntimeState();
  }

  private initializeStats(): VolumeStats {
    return {
      totalVolume: 0,
      buyVolume: 0,
      sellVolume: 0,
      orderCount: 0,
      startTime: Date.now(),
      lastOrderTime: 0,
    };
  }

  private initializeProfitStats(): ProfitStats {
    return {
      realFills: 0,
      washTrades: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      realFillRealizedPnl: 0,
      averageRealizedPnlPerRealFill: 0,
      bestRealizedFillPnl: 0,
      estimatedDailyRealizedPnl: 0,
      inventoryQuantity: 0,
      inventoryCostBasisUsd: 0,
      inventoryMarkPrice: 0,
    };
  }

  private loadPersistentRuntimeState(): void {
    try {
      if (!fs.existsSync(this.runtimeStatePath)) {
        return;
      }

      const raw = fs.readFileSync(this.runtimeStatePath, 'utf8');
      const state = JSON.parse(raw) as PersistentRuntimeState;

      if (state?.version !== 1) {
        return;
      }

      this.volumeStats.totalVolume = Number(state.volumeStats?.totalVolume || 0);
      this.volumeStats.buyVolume = Number(state.volumeStats?.buyVolume || 0);
      this.volumeStats.sellVolume = Number(state.volumeStats?.sellVolume || 0);
      this.volumeStats.orderCount = Number(state.volumeStats?.orderCount || 0);
      if (Number.isFinite(state.volumeStats?.startTime) && (state.volumeStats?.startTime || 0) > 0) {
        this.volumeStats.startTime = Number(state.volumeStats.startTime);
      }

      this.profitStats = {
        ...this.profitStats,
        ...state.profitStats,
      };

      this.realBuyFills = Number(state.realBuyFills || 0);
      this.realSellFills = Number(state.realSellFills || 0);
      this.lifetimeBaselineEpwx = state.lifetimeBaselineEpwx ?? null;
      this.lifetimeBaselineUsdt = state.lifetimeBaselineUsdt ?? null;
      this.latestEpwxTotal = state.latestEpwxTotal ?? null;
      this.latestUsdtTotal = state.latestUsdtTotal ?? null;

      this.recalculateProfitSnapshot();
      logger.info(`📦 Loaded persistent runtime state from ${this.runtimeStatePath}`);
    } catch (error) {
      logger.warn('⚠️  Failed to load persistent runtime state:', error);
    }
  }

  private persistRuntimeState(force: boolean = false): void {
    const now = Date.now();
    if (!force && now - this.lastStatePersistAt < 5000) {
      return;
    }

    const state: PersistentRuntimeState = {
      version: 1,
      savedAt: now,
      volumeStats: {
        totalVolume: this.volumeStats.totalVolume,
        buyVolume: this.volumeStats.buyVolume,
        sellVolume: this.volumeStats.sellVolume,
        orderCount: this.volumeStats.orderCount,
        startTime: this.volumeStats.startTime,
      },
      profitStats: this.profitStats,
      realBuyFills: this.realBuyFills,
      realSellFills: this.realSellFills,
      lifetimeBaselineEpwx: this.lifetimeBaselineEpwx,
      lifetimeBaselineUsdt: this.lifetimeBaselineUsdt,
      latestEpwxTotal: this.latestEpwxTotal,
      latestUsdtTotal: this.latestUsdtTotal,
    };

    try {
      fs.mkdirSync(path.dirname(this.runtimeStatePath), { recursive: true });
      fs.writeFileSync(this.runtimeStatePath, JSON.stringify(state, null, 2), 'utf8');
      this.lastStatePersistAt = now;
    } catch (error) {
      logger.warn('⚠️  Failed to persist runtime state:', error);
    }
  }

  private updateInventoryMarkPrice(markPrice: number): void {
    if (!Number.isFinite(markPrice) || markPrice <= 0) {
      return;
    }

    this.profitStats.inventoryMarkPrice = markPrice;
    this.recalculateProfitSnapshot();
  }

  private recalculateProfitSnapshot(): void {
    const inventoryQuantity = this.profitStats.inventoryQuantity;
    const inventoryCostBasisUsd = this.profitStats.inventoryCostBasisUsd;
    const inventoryMarkPrice = this.profitStats.inventoryMarkPrice;
    const averageEntryPrice = inventoryQuantity !== 0 ? inventoryCostBasisUsd / inventoryQuantity : 0;
    const unrealizedPnl =
      inventoryQuantity !== 0 && inventoryMarkPrice > 0
        ? (inventoryMarkPrice - averageEntryPrice) * inventoryQuantity
        : 0;

    this.profitStats.unrealizedPnl = unrealizedPnl;
    this.profitStats.totalPnl = this.profitStats.realizedPnl + unrealizedPnl;

    if (this.profitStats.realFills > 0) {
      this.profitStats.averageRealizedPnlPerRealFill = this.profitStats.realFillRealizedPnl / this.profitStats.realFills;
    } else {
      this.profitStats.averageRealizedPnlPerRealFill = 0;
    }

    const runtimeHours = (Date.now() - this.volumeStats.startTime) / (1000 * 60 * 60);
    this.profitStats.estimatedDailyRealizedPnl =
      (this.profitStats.realizedPnl / Math.max(runtimeHours, 0.01)) * 24;
  }

  private getTargetOrdersPerSide(): number {
    return Math.max(1, Math.floor(config.volumeStrategy.targetOrdersPerSide));
  }

  private getTargetBuyDepthUsd(): number {
    return Math.max(0, config.volumeStrategy.targetBuyDepthUsd);
  }

  private getTargetSellDepthUsd(): number {
    return Math.max(0, config.volumeStrategy.targetSellDepthUsd);
  }

  private applyEconomicFill(side: 'BUY' | 'SELL', amount: number, price: number, isWashTrade: boolean): number {
    if (!Number.isFinite(amount) || !Number.isFinite(price) || amount <= 0 || price <= 0) {
      return 0;
    }

    this.updateInventoryMarkPrice(price);

    if (isWashTrade) {
      return 0;
    }

    const fillDelta = side === 'BUY' ? amount : -amount;
    let inventoryQuantity = this.profitStats.inventoryQuantity;
    let inventoryCostBasisUsd = this.profitStats.inventoryCostBasisUsd;
    let realizedPnl = 0;

    const hasOpenInventory = inventoryQuantity !== 0;
    const sameDirection = !hasOpenInventory || Math.sign(inventoryQuantity) === Math.sign(fillDelta);

    if (sameDirection) {
      inventoryQuantity += fillDelta;
      inventoryCostBasisUsd += fillDelta * price;
    } else {
      const averageEntryPrice = inventoryCostBasisUsd / inventoryQuantity;
      const closingAmount = Math.min(Math.abs(inventoryQuantity), Math.abs(fillDelta));

      if (inventoryQuantity > 0) {
        realizedPnl = (price - averageEntryPrice) * closingAmount;
      } else {
        realizedPnl = (averageEntryPrice - price) * closingAmount;
      }

      if (Math.abs(fillDelta) < Math.abs(inventoryQuantity)) {
        inventoryQuantity += fillDelta;
        inventoryCostBasisUsd = inventoryQuantity * averageEntryPrice;
      } else if (Math.abs(fillDelta) === Math.abs(inventoryQuantity)) {
        inventoryQuantity = 0;
        inventoryCostBasisUsd = 0;
      } else {
        inventoryQuantity += fillDelta;
        inventoryCostBasisUsd = inventoryQuantity * price;
      }
    }

    this.profitStats.inventoryQuantity = inventoryQuantity;
    this.profitStats.inventoryCostBasisUsd = inventoryCostBasisUsd;
    this.profitStats.realizedPnl += realizedPnl;
    this.profitStats.realFillRealizedPnl += realizedPnl;
    this.profitStats.realFills++;
    if (side === 'BUY') {
      this.realBuyFills++;
    } else {
      this.realSellFills++;
    }

    if (realizedPnl > this.profitStats.bestRealizedFillPnl) {
      this.profitStats.bestRealizedFillPnl = realizedPnl;
    }

    this.recalculateProfitSnapshot();
    this.persistRuntimeState();
    return realizedPnl;
  }

  private getBalanceUtilizationPercent(): number {
    return Math.min(Math.max(config.volumeStrategy.balanceUtilizationPercent, 0), 1);
  }

  private getIdleBalanceReserveUsd(): number {
    return Math.max(config.volumeStrategy.idleBalanceReserveUsd, 0);
  }

  private getForceBuyPause(): boolean {
    return config.volumeStrategy.forceBuyPause;
  }

  private getBuyReactivationMode(): BuyReactivationMode {
    return config.volumeStrategy.buyReactivationMode;
  }

  private getMinNetEdgeBps(): number {
    return Math.max(config.volumeStrategy.minNetEdgeBps, 0);
  }

  private getMaxExecSpreadPercent(): number {
    return Math.max(config.volumeStrategy.maxExecSpreadPercent, 0);
  }

  private getMinExecDepthBuyUsd(): number {
    return Math.max(config.volumeStrategy.minExecDepthBuyUsd, 0);
  }

  private getMinExecDepthSellUsd(): number {
    return Math.max(config.volumeStrategy.minExecDepthSellUsd, 0);
  }

  private getAdverseFillRatioMax(): number {
    return Math.max(config.volumeStrategy.adverseFillRatioMax, 1);
  }

  private getAdverseFillInventoryLimitUsd(targetBuyDepthUsd: number): number {
    const configuredLimitUsd = config.volumeStrategy.adverseFillInventoryLimitUsd;
    if (Number.isFinite(configuredLimitUsd) && configuredLimitUsd > 0) {
      return configuredLimitUsd;
    }

    return Math.max(
      targetBuyDepthUsd * VolumeGenerationStrategy.ADVERSE_BUY_FILL_GUARD_INVENTORY_DEPTH_MULTIPLIER,
      VolumeGenerationStrategy.ADVERSE_BUY_FILL_GUARD_MIN_INVENTORY_USD
    );
  }

  private getSelfTradeMode(): SelfTradeMode {
    return config.volumeStrategy.selfTradeMode;
  }

  private getIdleWashEnableAfterMs(): number {
    return Math.max(config.volumeStrategy.idleWashEnableAfterMs, 0);
  }

  private getIdleWashCooldownAfterRealFillMs(): number {
    return Math.max(config.volumeStrategy.idleWashCooldownAfterRealFillMs, 0);
  }

  private getIdleWashMaxPairsPerCycle(): number {
    return Math.max(0, Math.floor(config.volumeStrategy.idleWashMaxPairsPerCycle));
  }

  private getIdleWashRequireLowDrift(): boolean {
    return config.volumeStrategy.idleWashRequireLowDrift;
  }

  private getIdleWashMaxDriftPercent(): number {
    return Math.max(config.volumeStrategy.idleWashMaxDriftPercent, 0);
  }

  private getIdleWashMaxExecSpreadPercent(): number {
    return Math.max(config.volumeStrategy.idleWashMaxExecSpreadPercent, 0);
  }

  private async cancelActiveWashOrders(reason: string): Promise<void> {
    const washOrderIds = new Set<string>();
    for (const pair of this.washTradePairsActive) {
      washOrderIds.add(pair.buyOrderId);
      washOrderIds.add(pair.sellOrderId);
    }

    if (!washOrderIds.size) {
      return;
    }

    logger.warn(`🧹 Cancelling ${washOrderIds.size} active wash order(s): ${reason}`);

    for (const orderId of washOrderIds) {
      try {
        await this.exchange.cancelOrder(this.symbol, orderId);
      } catch (error: any) {
        logger.warn(`⚠️  Failed to cancel wash order ${orderId}: ${error?.message || error}`);
      }
      this.activeOrders.delete(orderId);
      this.orderPrices.delete(orderId);
      this.settledWashOrderIds.add(orderId);
    }

    this.washTradePairsActive = [];
  }

  private noteRealFillDetected(reason: string): void {
    const now = Date.now();
    this.lastRealFillAt = now;

    if (this.getSelfTradeMode() !== 'auto') {
      return;
    }

    const cooldownMs = this.getIdleWashCooldownAfterRealFillMs();
    this.washAutoCooldownUntil = now + cooldownMs;
    const hadActiveWashOrders = this.washTradePairsActive.length > 0;
    if (this.washAutoEnabled || hadActiveWashOrders) {
      logger.warn(
        `🛑 Auto wash disabled after real fill (${reason}); cooldown ${Math.ceil(cooldownMs / 1000)}s.`
      );
    }
    this.washAutoEnabled = false;
    if (hadActiveWashOrders) {
      void this.cancelActiveWashOrders('real external fill detected while auto wash was active');
    }
  }

  private resolveWashTradeDecision(params: {
    canRunWashTradesByDrift: boolean;
    dexCexDriftPercent: number;
    executableSpreadPercent: number;
    adverseBuyGuardActive: boolean;
    forceBuyPause: boolean;
    dynamicWashTradePairs: number;
  }): { enabled: boolean; maxPairs: number; reason: string } {
    const mode = this.getSelfTradeMode();
    const now = Date.now();

    if (mode === 'off') {
      this.washAutoEnabled = false;
      return { enabled: false, maxPairs: 0, reason: 'SELF_TRADE_MODE=off' };
    }

    if (params.forceBuyPause) {
      this.washAutoEnabled = false;
      return { enabled: false, maxPairs: 0, reason: 'FORCE_BUY_PAUSE=true' };
    }

    if (params.adverseBuyGuardActive) {
      this.washAutoEnabled = false;
      return { enabled: false, maxPairs: 0, reason: 'adverse-fill buy guard active' };
    }

    if (!params.canRunWashTradesByDrift) {
      this.washAutoEnabled = false;
      return { enabled: false, maxPairs: 0, reason: 'DEX/CEX drift guard blocked wash trades' };
    }

    if (mode === 'on') {
      this.washAutoEnabled = false;
      return {
        enabled: true,
        maxPairs: Math.max(params.dynamicWashTradePairs, 0),
        reason: 'SELF_TRADE_MODE=on',
      };
    }

    if (now < this.washAutoCooldownUntil) {
      this.washAutoEnabled = false;
      return {
        enabled: false,
        maxPairs: 0,
        reason: `auto wash cooldown active (${Math.ceil((this.washAutoCooldownUntil - now) / 1000)}s remaining)`,
      };
    }

    const idleMs = now - this.lastRealFillAt;
    const idleThresholdMs = this.getIdleWashEnableAfterMs();
    if (idleMs < idleThresholdMs) {
      this.washAutoEnabled = false;
      return {
        enabled: false,
        maxPairs: 0,
        reason: `waiting for idle window (${Math.ceil((idleThresholdMs - idleMs) / 1000)}s remaining)`,
      };
    }

    if (this.getIdleWashRequireLowDrift()) {
      const maxIdleDriftPercent = this.getIdleWashMaxDriftPercent();
      if (params.dexCexDriftPercent > maxIdleDriftPercent) {
        this.washAutoEnabled = false;
        return {
          enabled: false,
          maxPairs: 0,
          reason: `idle wash drift guard blocked (${params.dexCexDriftPercent.toFixed(2)}% > ${maxIdleDriftPercent.toFixed(2)}%)`,
        };
      }

      const maxIdleExecSpreadPercent = this.getIdleWashMaxExecSpreadPercent();
      if (!Number.isFinite(params.executableSpreadPercent) || params.executableSpreadPercent > maxIdleExecSpreadPercent) {
        this.washAutoEnabled = false;
        return {
          enabled: false,
          maxPairs: 0,
          reason: `idle wash spread guard blocked (${params.executableSpreadPercent.toFixed(2)}% > ${maxIdleExecSpreadPercent.toFixed(2)}%)`,
        };
      }
    }

    this.washAutoEnabled = true;
    return {
      enabled: true,
      maxPairs: Math.min(Math.max(params.dynamicWashTradePairs, 0), this.getIdleWashMaxPairsPerCycle()),
      reason: 'SELF_TRADE_MODE=auto enabled after idle window',
    };
  }

  private getRiskSizeMultiplierDefensive(): number {
    return Math.min(Math.max(config.volumeStrategy.riskSizeMultiplierDefensive, 0.1), 1);
  }

  private getRiskSizeMultiplierNormal(): number {
    return Math.min(Math.max(config.volumeStrategy.riskSizeMultiplierNormal, 0.1), 1);
  }

  private resolveAutoBuySizingDecision(
    mode: BuyReactivationMode,
    gate: {
      allowBuys: boolean;
      evaluatedSpreadPercent: number | null;
      estimatedNetEdgeBps: number | null;
    },
    executableDepth: { buyDepthUsd: number; sellDepthUsd: number }
  ): { multiplier: number; regime: 'defensive' | 'normal' | 'neutral'; reason: string } {
    if (mode !== 'auto' || !gate.allowBuys) {
      return {
        multiplier: 1,
        regime: 'neutral',
        reason: 'Auto-mode sizing not applied',
      };
    }

    const defensiveMultiplier = this.getRiskSizeMultiplierDefensive();
    const normalMultiplier = Math.max(this.getRiskSizeMultiplierNormal(), defensiveMultiplier);
    const maxSpreadPercent = this.getMaxExecSpreadPercent();
    const minNetEdgeBps = this.getMinNetEdgeBps();
    const minBuyDepthUsd = this.getMinExecDepthBuyUsd();
    const minSellDepthUsd = this.getMinExecDepthSellUsd();

    const evaluatedSpreadPercent = Math.max(gate.evaluatedSpreadPercent ?? 0, 0);
    const estimatedNetEdgeBps = Math.max(gate.estimatedNetEdgeBps ?? 0, 0);
    const buyDepthRatio = minBuyDepthUsd > 0 ? executableDepth.buyDepthUsd / minBuyDepthUsd : Number.POSITIVE_INFINITY;
    const sellDepthRatio = minSellDepthUsd > 0 ? executableDepth.sellDepthUsd / minSellDepthUsd : Number.POSITIVE_INFINITY;
    const spreadHealthy = maxSpreadPercent > 0 ? evaluatedSpreadPercent <= maxSpreadPercent * 0.5 : true;
    const edgeHealthy = estimatedNetEdgeBps >= (minNetEdgeBps + 40);
    const depthHealthy = buyDepthRatio >= 1.5 && sellDepthRatio >= 1.5;

    if (spreadHealthy && edgeHealthy && depthHealthy) {
      return {
        multiplier: normalMultiplier,
        regime: 'normal',
        reason: `Auto-mode normal risk sizing (${normalMultiplier.toFixed(2)}x)`
      };
    }

    return {
      multiplier: defensiveMultiplier,
      regime: 'defensive',
      reason: `Auto-mode defensive risk sizing (${defensiveMultiplier.toFixed(2)}x)`
    };
  }

  private evaluateBuyReactivationGate(
    mode: BuyReactivationMode,
    placementPriceSource: PlacementPriceSource,
    executableSpreadPercent: number,
    tickerSpreadPercent: number | undefined,
    dexCexDriftPercent: number,
    maxDexCexDriftPercent: number,
    executableDepth: { buyDepthUsd: number; sellDepthUsd: number },
    adverseBuyGuardActive: boolean
  ): {
    allowBuys: boolean;
    reason: string;
    evaluatedSpreadPercent: number | null;
    estimatedNetEdgeBps: number | null;
  } {
    if (mode === 'off') {
      return {
        allowBuys: false,
        reason: 'BUY_REACTIVATION_MODE=off',
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    if (mode === 'on') {
      return {
        allowBuys: true,
        reason: 'BUY_REACTIVATION_MODE=on',
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    if (placementPriceSource === 'DEX_FALLBACK') {
      return {
        allowBuys: false,
        reason: 'BUY_REACTIVATION_MODE=auto requires CEX-based placement source',
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    if (dexCexDriftPercent > maxDexCexDriftPercent) {
      return {
        allowBuys: false,
        reason: `BUY_REACTIVATION_MODE=auto blocked buys: DEX/CEX drift ${dexCexDriftPercent.toFixed(2)}% > ${maxDexCexDriftPercent.toFixed(2)}%`,
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    if (adverseBuyGuardActive) {
      return {
        allowBuys: false,
        reason: 'BUY_REACTIVATION_MODE=auto blocked buys: adverse-fill guard active',
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    const minExecDepthBuyUsd = this.getMinExecDepthBuyUsd();
    const minExecDepthSellUsd = this.getMinExecDepthSellUsd();
    if (executableDepth.buyDepthUsd < minExecDepthBuyUsd || executableDepth.sellDepthUsd < minExecDepthSellUsd) {
      return {
        allowBuys: false,
        reason: `BUY_REACTIVATION_MODE=auto blocked buys: executable depth buy=$${executableDepth.buyDepthUsd.toFixed(2)} / sell=$${executableDepth.sellDepthUsd.toFixed(2)} below minimum buy=$${minExecDepthBuyUsd.toFixed(2)} sell=$${minExecDepthSellUsd.toFixed(2)}`,
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    const evaluatedSpreadPercent = placementPriceSource === 'EXECUTABLE_BOOK_MID'
      ? executableSpreadPercent
      : tickerSpreadPercent;
    if (!Number.isFinite(evaluatedSpreadPercent)) {
      return {
        allowBuys: false,
        reason: 'BUY_REACTIVATION_MODE=auto could not determine a finite spread',
        evaluatedSpreadPercent: null,
        estimatedNetEdgeBps: null,
      };
    }

    const safeSpreadPercent = Math.max(evaluatedSpreadPercent ?? 0, 0);
    const maxExecSpreadPercent = this.getMaxExecSpreadPercent();
    if (safeSpreadPercent > maxExecSpreadPercent) {
      return {
        allowBuys: false,
        reason: `BUY_REACTIVATION_MODE=auto blocked buys: spread ${safeSpreadPercent.toFixed(2)}% > ${maxExecSpreadPercent.toFixed(2)}%`,
        evaluatedSpreadPercent: safeSpreadPercent,
        estimatedNetEdgeBps: safeSpreadPercent * 100,
      };
    }

    const estimatedNetEdgeBps = safeSpreadPercent * 100;
    const minNetEdgeBps = this.getMinNetEdgeBps();
    if (estimatedNetEdgeBps < minNetEdgeBps) {
      return {
        allowBuys: false,
        reason: `BUY_REACTIVATION_MODE=auto blocked buys: estimated net edge ${estimatedNetEdgeBps.toFixed(1)} bps < ${minNetEdgeBps.toFixed(1)} bps`,
        evaluatedSpreadPercent: safeSpreadPercent,
        estimatedNetEdgeBps,
      };
    }

    return {
      allowBuys: true,
      reason: `BUY_REACTIVATION_MODE=auto passed: spread ${safeSpreadPercent.toFixed(2)}%, estimated net edge ${estimatedNetEdgeBps.toFixed(1)} bps`,
      evaluatedSpreadPercent: safeSpreadPercent,
      estimatedNetEdgeBps,
    };
  }

  private getAdaptiveOrderAmountCap(price?: number, availableUsd?: number): number {
    const configuredTokenCap = Math.floor(config.volumeStrategy.maxOrderAmountTokens);
    const minimumTokenCap = Math.max(this.minQty, configuredTokenCap);

    if (!Number.isFinite(price) || !price || price <= 0) {
      return minimumTokenCap;
    }

    const minimumUsd = this.getMinimumOrderUsdTarget();
    const configuredNotionalUsd = Math.max(config.volumeStrategy.maxOrderSize, minimumUsd);
    const reserveAdjustedUsd = Number.isFinite(availableUsd)
      ? Math.max((availableUsd ?? 0) - this.getIdleBalanceReserveUsd(), minimumUsd)
      : configuredNotionalUsd;
    const targetUsd = Math.max(configuredNotionalUsd, reserveAdjustedUsd * this.getBalanceUtilizationPercent());
    const dynamicTokenCap = Math.floor(targetUsd / price);

    return Math.max(minimumTokenCap, dynamicTokenCap, this.minQty);
  }

  private applyOrderAmountCap(amount: number, context: string, price?: number, availableUsd?: number): number {
    const configuredCap = Math.floor(config.volumeStrategy.maxOrderAmountTokens);
    const staticCap = Number.isFinite(configuredCap) && configuredCap >= this.minQty ? configuredCap : this.minQty;
    const adaptiveCap = this.getAdaptiveOrderAmountCap(price, availableUsd);
    const cap = Math.max(this.minQty, Math.min(staticCap, adaptiveCap));

    if (amount > cap) {
      logger.warn(`⚠️  Capping ${context} order amount from ${amount} to ${cap} EPWX (MAX_ORDER_AMOUNT_TOKENS)`);
      return cap;
    }

    return amount;
  }

  private normalizeOrderAmount(amount: number, price?: number, availableUsd?: number): number | null {
    const normalizedAmount = this.applyOrderAmountCap(Math.floor(amount), 'normalized', price, availableUsd);

    if (!Number.isFinite(normalizedAmount) || normalizedAmount < this.minQty) {
      return null;
    }

    return normalizedAmount;
  }

  private isValidOrderAmount(amount: number, price?: number): boolean {
    if (!Number.isFinite(amount) || amount < this.minQty || amount === 0) {
      return false;
    }

    if (price !== undefined && amount * price < VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD) {
      return false;
    }

    return true;
  }

  private getMinimumOrderUsdTarget(): number {
    return VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD + 0.25;
  }

  private evaluateAdverseBuyFillGuard(markPrice: number, targetBuyDepthUsd: number): {
    active: boolean;
    buyFillGap: number;
    buySellRatio: number;
    longInventoryUsd: number;
    inventoryLimitUsd: number;
  } {
    const buyFillGap = this.realBuyFills - this.realSellFills;
    const buySellRatio = this.realBuyFills / Math.max(this.realSellFills, 1);
    const safeMarkPrice = Number.isFinite(markPrice) && markPrice > 0 ? markPrice : 0;
    const longInventoryUsd = Math.max(this.profitStats.inventoryQuantity, 0) * safeMarkPrice;
    const inventoryLimitUsd = this.getAdverseFillInventoryLimitUsd(targetBuyDepthUsd);

    const hasLongInventoryBias = this.profitStats.inventoryQuantity > 0 || this.currentPosition > 0;
    const hasPersistentBuyFillImbalance =
      hasLongInventoryBias &&
      this.realBuyFills >= VolumeGenerationStrategy.ADVERSE_BUY_FILL_GUARD_MIN_REAL_BUY_FILLS &&
      buyFillGap >= VolumeGenerationStrategy.ADVERSE_BUY_FILL_GUARD_MIN_GAP &&
      buySellRatio >= this.getAdverseFillRatioMax();
    const hasExcessLongInventory = longInventoryUsd >= inventoryLimitUsd;

    return {
      active: hasPersistentBuyFillImbalance || hasExcessLongInventory,
      buyFillGap,
      buySellRatio,
      longInventoryUsd,
      inventoryLimitUsd,
    };
  }

  private getEffectiveOrderUsdCap(availableUsd: number): number {
    const minimumUsd = this.getMinimumOrderUsdTarget();
    const configuredMaxUsd = Math.max(config.volumeStrategy.maxOrderSize, minimumUsd);
    const balanceDrivenCapUsd = Math.min(Math.max(availableUsd * 0.1, minimumUsd), 100);

    return Math.max(configuredMaxUsd, balanceDrivenCapUsd);
  }

  private getBalanceAwareOrderUsdTarget(
    availableUsd: number,
    targetOrderCount: number,
    utilizationPercent: number = 0.92
  ): number {
    const minimumUsd = this.getMinimumOrderUsdTarget();
    const budgetUsd = (Math.max(availableUsd, 0) * Math.min(Math.max(utilizationPercent, 0), 1)) / Math.max(targetOrderCount, 1);
    const cappedUsd = Math.min(budgetUsd, this.getEffectiveOrderUsdCap(availableUsd));

    return Math.max(minimumUsd, cappedUsd);
  }

  private getDynamicOrderUsdTarget(baseUsd: number, remainingUsd?: number): number {
    const minimumUsd = this.getMinimumOrderUsdTarget();
    const safeBaseUsd = Math.max(baseUsd, minimumUsd);
    const lowerBoundUsd = Math.max(minimumUsd, safeBaseUsd * 0.82);
    const upperBoundUsd = Math.max(lowerBoundUsd, safeBaseUsd * 1.18);
    const randomizedUsd = lowerBoundUsd + (Math.random() * (upperBoundUsd - lowerBoundUsd));

    if (remainingUsd === undefined) {
      return randomizedUsd;
    }

    return Math.min(randomizedUsd, Math.max(minimumUsd, remainingUsd));
  }

  private selectPlacementPriceReference(
    washPriceReference: number,
    executableMidPrice: number,
    executableMidUsable: boolean,
    biconomyPrice: number
  ): { priceReference: number; source: PlacementPriceSource } {
    if (executableMidUsable) {
      return { priceReference: executableMidPrice, source: 'EXECUTABLE_BOOK_MID' };
    }

    if (Number.isFinite(biconomyPrice) && biconomyPrice > 0) {
      return { priceReference: biconomyPrice, source: 'CEX_TICKER_MID' };
    }

    return { priceReference: washPriceReference, source: 'DEX_FALLBACK' };
  }

  private getDexAnchoredQuotePolicy(
    dexPrice: number,
    cexPrice: number
  ): { allowBuys: boolean; allowSells: boolean; buyReference: number; sellReference: number } {
    if (
      !config.volumeStrategy.dexAnchoredQuotingEnabled ||
      !Number.isFinite(dexPrice) ||
      dexPrice <= 0 ||
      !Number.isFinite(cexPrice) ||
      cexPrice <= 0
    ) {
      return { allowBuys: true, allowSells: true, buyReference: cexPrice, sellReference: cexPrice };
    }

    const sellPremiumBps = Math.max(config.volumeStrategy.dexAnchoredSellMinPremiumBps, 0);
    const buyDiscountBps = Math.max(config.volumeStrategy.dexAnchoredBuyMaxDiscountBps, 0);
    const cexBelowDex = cexPrice < dexPrice;

    return {
      allowBuys: !cexBelowDex,
      allowSells: true,
      buyReference: dexPrice * (1 - buyDiscountBps / 10000),
      sellReference: dexPrice * (1 + sellPremiumBps / 10000),
    };
  }

  private selectQuotePlacementDriftMode(
    placementPriceSource: PlacementPriceSource,
    hasValidBiconomyReference: boolean,
    dexCexDriftPercent: number,
    maxDexCexDriftPercent: number
  ): { allowQuotePlacements: boolean; mode: 'NORMAL' | 'CEX_ONLY' | 'PAUSED' } {
    const driftProtectionEnabled = config.volumeStrategy.pauseWashOnHighDrift;
    const driftTooHigh =
      driftProtectionEnabled &&
      hasValidBiconomyReference &&
      dexCexDriftPercent > maxDexCexDriftPercent;

    if (!driftTooHigh) {
      return { allowQuotePlacements: true, mode: 'NORMAL' };
    }

    if (placementPriceSource === 'DEX_FALLBACK') {
      return { allowQuotePlacements: false, mode: 'PAUSED' };
    }

    return { allowQuotePlacements: true, mode: 'CEX_ONLY' };
  }

  private getInventorySkewPercent(): number {
    const maxSkewPercent = Math.max(config.volumeStrategy.inventorySkewMaxPercent, 0);
    if (maxSkewPercent === 0) {
      return 0;
    }

    const positionThreshold = Math.max(config.marketMaking.positionRebalanceThreshold, 1);
    const activationRatio = Math.min(Math.max(config.volumeStrategy.inventorySkewActivationRatio, 0), 1);
    const activationThreshold = positionThreshold * activationRatio;
    const absolutePosition = Math.abs(this.currentPosition);

    if (absolutePosition <= activationThreshold) {
      return 0;
    }

    const effectiveRange = Math.max(positionThreshold - activationThreshold, positionThreshold * 0.1);
    const normalizedPosition = Math.min((absolutePosition - activationThreshold) / effectiveRange, 1);
    const direction = this.currentPosition > 0 ? -1 : 1;

    return direction * maxSkewPercent * normalizedPosition;
  }

  private applyInventorySkewToQuotePrice(price: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      return price;
    }

    const skewPercent = this.getInventorySkewPercent();
    if (skewPercent === 0) {
      return price;
    }

    return Math.max(price * (1 + skewPercent), Number.EPSILON);
  }

  private getPassiveQuoteBands(referencePrice: number): {
    minBuyPrice: number;
    maxBuyPrice: number;
    minSellPrice: number;
    maxSellPrice: number;
  } {
    const buyOuterOffset = Math.max(config.volumeStrategy.passiveBuyBandOuterOffsetPercent, 0);
    const buyInnerOffset = Math.min(Math.max(config.volumeStrategy.passiveBuyBandInnerOffsetPercent, 0), buyOuterOffset);
    const sellInnerOffset = Math.max(config.volumeStrategy.passiveSellBandInnerOffsetPercent, 0);
    const sellOuterOffset = Math.max(config.volumeStrategy.passiveSellBandOuterOffsetPercent, sellInnerOffset);

    return {
      minBuyPrice: referencePrice * (1 - buyOuterOffset),
      maxBuyPrice: referencePrice * (1 - buyInnerOffset),
      minSellPrice: referencePrice * (1 + sellInnerOffset),
      maxSellPrice: referencePrice * (1 + sellOuterOffset)
    };
  }

  private getPassiveSeededQuotePrice(referencePrice: number, side: 'BUY' | 'SELL', level: number): number {
    const baseOffset = Math.max(config.volumeStrategy.passiveSeedBaseOffsetPercent, 0);
    const stepOffset = Math.max(config.volumeStrategy.passiveSeedStepOffsetPercent, 0);
    const offset = baseOffset + (Math.max(level, 0) * stepOffset);

    return side === 'BUY'
      ? referencePrice * (1 - offset)
      : referencePrice * (1 + offset);
  }

  private async clampPriceToLatestBand(price: number, side: 'BUY' | 'SELL' = 'BUY'): Promise<number> {
    const ticker = await this.exchange.getTicker(this.symbol);
    const latestPrice = ticker?.price ?? 0;

    if (!Number.isFinite(latestPrice) || latestPrice <= 0) {
      return price;
    }

    const bandHalfWidth = config.volumeStrategy.latestPriceBandHalfWidthPercent / 100;
    let lowerBound = latestPrice * (1 - bandHalfWidth);
    let upperBound = latestPrice * (1 + bandHalfWidth);

    // In sell-only recovery mode, allow sell quotes to anchor near real-user bids.
    if (
      side === 'SELL' &&
      config.volumeStrategy.sellNearBidEnabled &&
      this.getForceBuyPause()
    ) {
      const bid = Number(ticker?.bid ?? 0);
      const ask = Number(ticker?.ask ?? 0);
      const bestBid = Math.min(bid, ask);
      const bestAsk = Math.max(bid, ask);

      if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0) {
        const tick = this.getEffectiveTickSize();
        const minSellAboveBid = bestBid + tick;
        lowerBound = Math.max(minSellAboveBid, Number.EPSILON);
        upperBound = Math.max(upperBound, bestAsk);
      }
    }

    return Math.min(Math.max(price, lowerBound), upperBound);
  }

  private isExtremeClampReprice(requestedPrice: number, executablePrice: number): boolean {
    if (!Number.isFinite(requestedPrice) || !Number.isFinite(executablePrice) || requestedPrice <= 0 || executablePrice <= 0) {
      return true;
    }

    const ratio = executablePrice / requestedPrice;
    return ratio > VolumeGenerationStrategy.MAX_CLAMP_REPRICE_RATIO || ratio < (1 / VolumeGenerationStrategy.MAX_CLAMP_REPRICE_RATIO);
  }

  private getEffectiveTickSize(): number {
    return Number.isFinite(this.tickSize) && this.tickSize > 0 ? this.tickSize : 1e-13;
  }

  private async offsetSellPriceFromOpenLevels(price: number): Promise<number> {
    const exchangeWithOpenOrders = this.exchange as any;
    if (typeof exchangeWithOpenOrders.getOpenOrders !== 'function') {
      return price;
    }

    const openOrders: Order[] = await exchangeWithOpenOrders.getOpenOrders(this.symbol);
    const sellOrders = openOrders.filter(order => order.side === 'SELL');
    if (!sellOrders.length) {
      return price;
    }

    const tick = this.getEffectiveTickSize();
    const sameLevelCount = sellOrders.filter(order => Math.abs(order.price - price) <= (tick / 2)).length;
    if (sameLevelCount === 0) {
      return price;
    }

    let adjustedPrice = price;
    for (let i = 0; i < sameLevelCount; i++) {
      const candidatePrice = adjustedPrice + tick;
      const clampedCandidatePrice = await this.clampPriceToLatestBand(candidatePrice, 'SELL');
      if (clampedCandidatePrice <= adjustedPrice) {
        break;
      }
      adjustedPrice = clampedCandidatePrice;
    }

    if (adjustedPrice !== price) {
      logger.info(
        `↗️ Offsetting sell price by ${sameLevelCount} tick(s) to avoid same-price stacking: ${price.toExponential(4)} -> ${adjustedPrice.toExponential(4)}`
      );
    }

    return adjustedPrice;
  }

  private async wouldCrossOpenBook(side: 'BUY' | 'SELL', price: number): Promise<boolean> {
    const exchangeWithOpenOrders = this.exchange as any;
    if (typeof exchangeWithOpenOrders.getOpenOrders !== 'function') {
      return false;
    }

    try {
      const openOrders: Order[] = await exchangeWithOpenOrders.getOpenOrders(this.symbol);
      const tick = this.getEffectiveTickSize();

      if (side === 'BUY') {
        const bestAsk = openOrders
          .filter(order => order.side === 'SELL' && Number.isFinite(order.price))
          .reduce((best, order) => Math.min(best, order.price), Number.POSITIVE_INFINITY);

        return Number.isFinite(bestAsk) && price >= bestAsk - (tick / 2);
      }

      const bestBid = openOrders
        .filter(order => order.side === 'BUY' && Number.isFinite(order.price))
        .reduce((best, order) => Math.max(best, order.price), 0);

      return bestBid > 0 && price <= bestBid + (tick / 2);
    } catch (error) {
      logger.warn(`⚠️  Skipping ${side} placement because the open book could not be verified before submission.`, error);
      return true;
    }
  }

  private recalculateExecutableOrderAmount(
    side: 'BUY' | 'SELL',
    requestedPrice: number,
    requestedAmount: number,
    executablePrice: number,
    availableUSDT: number,
    availableEPWX: number
  ): number | null {
    if (!Number.isFinite(requestedPrice) || !Number.isFinite(requestedAmount) || !Number.isFinite(executablePrice) || executablePrice <= 0) {
      return null;
    }

    const requestedNotionalUsd = requestedPrice * requestedAmount;
    const spendableUsd = side === 'BUY'
      ? Math.max(availableUSDT - this.getIdleBalanceReserveUsd(), 0)
      : Math.max(availableEPWX * executablePrice, 0);

    if (spendableUsd < VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD) {
      return null;
    }

    const targetNotionalUsd = Math.min(requestedNotionalUsd, spendableUsd);
    const recalculatedAmount = Math.floor(targetNotionalUsd / executablePrice);
    const cappedAmount = this.applyOrderAmountCap(recalculatedAmount, side, executablePrice, spendableUsd);

    return cappedAmount >= this.minQty ? cappedAmount : null;
  }

  private selectPassiveTopTouchPrices(
    executableBestBid: number,
    executableBestAsk: number
  ): { buyPrice: number; sellPrice: number } | null {
    if (
      !Number.isFinite(executableBestBid) ||
      !Number.isFinite(executableBestAsk) ||
      executableBestBid <= 0 ||
      executableBestAsk <= 0
    ) {
      return null;
    }

    const bestBid = Math.min(executableBestBid, executableBestAsk);
    const bestAsk = Math.max(executableBestBid, executableBestAsk);
    const spread = bestAsk - bestBid;

    // Keep maker behavior while improving queue priority by posting slightly inside the spread.
    const configuredFraction = Math.min(Math.max(config.volumeStrategy.topTouchImprovementSpreadFraction, 0), 0.49);
    const improvement = spread > 0 ? spread * configuredFraction : 0;
    const buyPrice = bestBid + improvement;
    const sellPrice = bestAsk - improvement;

    return {
      buyPrice: Math.min(buyPrice, sellPrice),
      sellPrice: Math.max(sellPrice, buyPrice)
    };
  }

  private formatTopBookLevels(levels: Array<[number, number]>, maxLevels: number = 5): string {
    if (!levels.length) {
      return 'none';
    }

    return levels
      .slice(0, maxLevels)
      .map(([price, amount]) => `${price.toExponential(4)} x ${Math.floor(amount).toLocaleString()}`)
      .join(' | ');
  }

  private async logExecutableBookSnapshot(
    referencePrice: number,
    tickerBid: number,
    tickerAsk: number
  ): Promise<{ bestBid: number; bestAsk: number; midPrice: number; bids: Array<[number, number]>; asks: Array<[number, number]> } | null> {
    const exchangeWithBook = this.exchange as any;
    if (typeof exchangeWithBook.getOrderBook !== 'function') {
      return null;
    }

    try {
      const orderBook = await exchangeWithBook.getOrderBook(this.symbol);
      const bestBid = orderBook.bids[0]?.[0] ?? 0;
      const bestAsk = orderBook.asks[0]?.[0] ?? 0;
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
      const spread = bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;

      logger.info(
        `📚 [EXEC BOOK] bestBid=${bestBid.toExponential(4)} bestAsk=${bestAsk.toExponential(4)} spread=${spread.toFixed(3)}% | tickerBid=${tickerBid.toExponential(4)} tickerAsk=${tickerAsk.toExponential(4)} ref=${referencePrice.toExponential(4)}`
      );
      logger.info(
        `📚 [EXEC BOOK] bids: ${this.formatTopBookLevels(orderBook.bids)} | asks: ${this.formatTopBookLevels(orderBook.asks)}`
      );
      return {
        bestBid,
        bestAsk,
        midPrice,
        bids: orderBook.bids,
        asks: orderBook.asks,
      };
    } catch (error) {
      logger.warn('⚠️  Failed to fetch executable order book snapshot for diagnostics:', error);
      return null;
    }
  }

  private calculateExecutableDepthUsd(
    executableBookSnapshot: { bids: Array<[number, number]>; asks: Array<[number, number]> } | null,
    priceReference: number
  ): { buyDepthUsd: number; sellDepthUsd: number } {
    if (!executableBookSnapshot || !Number.isFinite(priceReference) || priceReference <= 0) {
      return { buyDepthUsd: 0, sellDepthUsd: 0 };
    }

    const buyDepthFloor = priceReference * (1 - VolumeGenerationStrategy.EXECUTABLE_DEPTH_BAND_PERCENT);
    const sellDepthCeil = priceReference * (1 + VolumeGenerationStrategy.EXECUTABLE_DEPTH_BAND_PERCENT);
    const buyDepthUsd = executableBookSnapshot.bids
      .filter(([price]) => Number.isFinite(price) && price >= buyDepthFloor)
      .reduce((sum, [price, amount]) => sum + (price * amount), 0);
    const sellDepthUsd = executableBookSnapshot.asks
      .filter(([price]) => Number.isFinite(price) && price <= sellDepthCeil)
      .reduce((sum, [price, amount]) => sum + (price * amount), 0);

    return {
      buyDepthUsd,
      sellDepthUsd,
    };
  }

  private async logPostPlacementOrderState(orderId: string, side: 'BUY' | 'SELL', requestedPrice: number): Promise<void> {
    const exchangeWithOrder = this.exchange as any;
    if (typeof exchangeWithOrder.getOrder !== 'function') {
      return;
    }

    try {
      const pendingOrder = await exchangeWithOrder.getOrder(this.symbol, orderId);
      logger.info(
        `🧾 [POST-PLACE] ${side} ${orderId} pending: price=${pendingOrder.price.toExponential(4)} amount=${Math.floor(pendingOrder.amount).toLocaleString()} filled=${Math.floor(pendingOrder.filled).toLocaleString()} requested=${requestedPrice.toExponential(4)}`
      );
    } catch (error: any) {
      const message = error?.message || 'unknown';
      logger.warn(`🧾 [POST-PLACE] ${side} ${orderId} is not pending immediately after placement (message=${message}).`);
    }
  }

  private async logNoFillDiagnostics(orderId: string, side: 'BUY' | 'SELL'): Promise<void> {
    const exchangeWithOpenOrders = this.exchange as any;
    if (typeof exchangeWithOpenOrders.getOpenOrders !== 'function') {
      return;
    }

    const maxDiagnosticsPerCycle = 3;
    if (this.noFillDiagnosticsThisCycle >= maxDiagnosticsPerCycle) {
      return;
    }

    this.noFillDiagnosticsThisCycle += 1;

    try {
      const openOrders: Order[] = await exchangeWithOpenOrders.getOpenOrders(this.symbol);
      const pendingOrder = openOrders.find((order: Order) => order.orderId === orderId);
      const buyCount = openOrders.filter((order: Order) => order.side === 'BUY').length;
      const sellCount = openOrders.filter((order: Order) => order.side === 'SELL').length;

      if (pendingOrder) {
        logger.info(
          `🔎 [NO-FILL] ${side} ${orderId} still pending after 1s: price=${pendingOrder.price.toExponential(4)} amount=${Math.floor(pendingOrder.amount).toLocaleString()} filled=${Math.floor(pendingOrder.filled).toLocaleString()} | openBook=${buyCount} buys/${sellCount} sells`
        );
      } else {
        logger.warn(
          `🔎 [NO-FILL] ${side} ${orderId} not found in pending list after 1s | openBook=${buyCount} buys/${sellCount} sells`
        );
      }
    } catch (error) {
      logger.warn(`⚠️  [NO-FILL] Failed to collect pending-order diagnostics for ${orderId}:`, error);
    }
  }

  private async logOrderDisappearance(orderId: string): Promise<void> {
    const exchangeWithOpenOrders = this.exchange as any;
    if (typeof exchangeWithOpenOrders.getOpenOrders !== 'function') {
      return;
    }

    try {
      const openOrders: Order[] = await exchangeWithOpenOrders.getOpenOrders(this.symbol);
      const stillPending = openOrders.some((order: Order) => order.orderId === orderId);
      const buyCount = openOrders.filter((order: Order) => order.side === 'BUY').length;
      const sellCount = openOrders.filter((order: Order) => order.side === 'SELL').length;

      logger.warn(
        `🛰️  [ORDER-DISAPPEARED] ${orderId} missing from pending detail; pendingListContainsOrder=${stillPending} | openBook=${buyCount} buys/${sellCount} sells`
      );
    } catch (error) {
      logger.warn(`⚠️  Failed to log disappearance diagnostics for order ${orderId}:`, error);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Volume generation strategy is already running');
      return;
    }

    this.isPlacingOrders = false;

    logger.info('🚀 Starting Biconomy Exchange Volume Generation Bot...');
    logger.info(`Target: $${config.volumeStrategy.volumeTargetDaily.toLocaleString()} daily volume`);
    logger.info(`Pair: ${this.symbol}`);
    logger.info(`Spread: ${config.volumeStrategy.spreadPercentage}%`);
    logger.info(`Order Frequency: ${config.volumeStrategy.orderFrequency}ms`);
    if (this.getForceBuyPause()) {
      logger.warn('🧯 FORCE_BUY_PAUSE=true: all BUY placements are disabled by policy.');
    }
    
    // Check if ORDER_FREQUENCY is too high (potential misconfiguration)
    if (config.volumeStrategy.orderFrequency > 60000) {
      logger.warn(`⚠️  WARNING: ORDER_FREQUENCY is ${config.volumeStrategy.orderFrequency}ms (${(config.volumeStrategy.orderFrequency/1000).toFixed(1)}s) - this is very slow!`);
      logger.warn(`   To place orders every 5 seconds, set ORDER_FREQUENCY=5000 in your .env file`);
    }

    // Fetch step size and minQty for EPWX/USDT
    try {
      const pairInfo = await getEPWXPairInfo();
      if (pairInfo.symbol === 'EPWX_USDT') {
        this.stepSize = 1;
      } else if (pairInfo.stepSize) {
        this.stepSize = Number(pairInfo.stepSize);
      }
      if (pairInfo.tickSize && Number(pairInfo.tickSize) > 0) {
        this.tickSize = Number(pairInfo.tickSize);
      }
      if (pairInfo.minQty) this.minQty = Number(pairInfo.minQty);
      logger.info(`[PAIR INFO] stepSize=${this.stepSize}, minQty=${this.minQty}, baseAssetPrecision=${pairInfo.baseAssetPrecision}, quoteAssetPrecision=${pairInfo.quoteAssetPrecision}, tickSize=${pairInfo.tickSize}`);
    } catch (e) {
      logger.warn('Could not fetch EPWX/USDT pair info, using defaults.');
    }
    this.isRunning = true;

    try {
      // Cancel any existing orders only when startup cancellation is enabled.
      if (config.operations.cancelOrdersOnStart) {
        try {
          logger.info('Attempting to cancel existing orders...');
          const cancelled = await this.exchange.cancelAllOrders(this.symbol);
          logger.info(`✅ Cancelled ${cancelled} existing orders`);
        } catch (error: any) {
          logger.warn('⚠️  Could not cancel existing orders (endpoint may not be available):', error.message);
        }
      } else {
        logger.info('⏭️  Skipping startup order cancellation (CANCEL_ORDERS_ON_START=false).');
      }

      // Get initial balances
      await this.logBalances();
      await this.syncCurrentPositionWithBalances();
      this.persistRuntimeState(true);

      // Start order placement loop
      this.startOrderPlacementLoop();

      // Start monitoring loop
      this.startMonitoringLoop();

      logger.info('✅ Volume generation bot started successfully');
    } catch (error) {
      logger.error('Failed to start volume generation bot:', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning && !this.isPlacingOrders) {
      return;
    }

    logger.info('🛑 Stopping volume generation bot...');
    this.isRunning = false;

    if (this.orderTimer) {
      clearInterval(this.orderTimer);
      this.orderTimer = undefined;
    }

    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }

    try {
      if (config.operations.cancelOrdersOnStop) {
        await this.exchange.cancelAllOrders(this.symbol);
      } else {
        logger.info('⏭️  Skipping shutdown order cancellation (CANCEL_ORDERS_ON_STOP=false).');
      }
      this.activeOrders.clear();

      await this.logFinalStats();
      this.persistRuntimeState(true);
      logger.info('✅ Volume generation bot stopped');
    } catch (error) {
      logger.error('Error stopping bot:', error);
    }
  }

  private startOrderPlacementLoop(): void {
    const effectiveOrderFrequency = Math.min(config.volumeStrategy.orderFrequency, 30000);
    if (effectiveOrderFrequency !== config.volumeStrategy.orderFrequency) {
      logger.warn(`⚠️  Capping order placement frequency from ${config.volumeStrategy.orderFrequency}ms to ${effectiveOrderFrequency}ms so book orders are refreshed before they disappear from pending.`);
    }
    logger.info(`📅 Order placement loop starting with frequency: ${effectiveOrderFrequency}ms`);
    
    this.orderTimer = setInterval(async () => {
      if (!this.isRunning) return;
      if (this.isPlacingOrders) {
        logger.warn('Skipping order placement tick because the previous cycle is still running');
        return;
      }

      try {
        logger.info('▶️  Calling placeVolumeOrders...');
        await this.placeVolumeOrders();
      } catch (error) {
        logger.error('❌ Error in order placement loop:', error);
      }
    }, effectiveOrderFrequency);
  }

  private startMonitoringLoop(): void {
    this.updateTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.updateOrderStatus();
        await this.syncCurrentPositionWithBalances();
        await this.checkAndRebalancePosition();
        this.logPerformance();
      } catch (error) {
        logger.error('Error in monitoring loop:', error);
      }
    }, config.marketMaking.updateInterval);
  }

  private async placeVolumeOrders(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isPlacingOrders = true;
    this.noFillDiagnosticsThisCycle = 0;

    try {
      logger.info('🔄 Starting order placement cycle');
      logger.debug('DEBUG: Entered placeVolumeOrders');

      // Fetch DEX price from PancakeSwap (EPWX/WETH + configured ETH/USD source)
      logger.info('🔄 [DEX] Fetching EPWX price from PancakeSwap...');
      let dexPriceUSD: number | undefined;
      try {
        dexPriceUSD = await fetchEpwXPriceFromPancake(
          config.trading.baseRpcUrl,
          config.trading.epwxWethPairAddress,
          config.trading.epwxAddress,
          {
            source: config.trading.ethUsdSource,
            chainlinkFeedAddress: config.trading.ethUsdChainlinkFeedAddress,
            fallbackPriceUsd: config.trading.ethUsdFallback,
            coingeckoUrl: config.trading.coingeckoEthUsdUrl,
            cacheMs: config.trading.ethUsdCacheMs,
          }
        );
        logger.info(`🥞 DEX (PancakeSwap) price fetched: 1 EPWX ≈ ${dexPriceUSD} USD`);
        // Apply markup for CEX mirroring
        // Use configurable discount to align DEX reference with structural CEX/DEX gap
        const discountPercent = config.volumeStrategy.dexPriceDiscountPercent;
        const discountMultiplier = 1 - discountPercent / 100;
        const discountedPrice = dexPriceUSD * discountMultiplier;
        logger.info(`🔸 DEX price after ${discountPercent}% discount: 1 EPWX ≈ ${discountedPrice} USD`);
        // Use discountedPrice as the reference for order placement
        var lastPrice = discountedPrice;
      } catch (error) {
        logger.error('❌ Failed to fetch DEX price from PancakeSwap:', error);
        return;
      }
      logger.debug(`DEBUG: After DEX price fetch and markup, lastPrice=${lastPrice}`);
      if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
        logger.warn('⚠️  No valid DEX price available after USD conversion, skipping');
        logger.debug('DEBUG: Early return due to invalid lastPrice');
        return;
      }


      // --- Hybrid price reference logic ---
      // Fetch Biconomy market price (ticker)
      let biconomyPrice = 0, biconomyBid = 0, biconomyAsk = 0;
      try {
        const ticker = await this.exchange.getTicker(this.symbol);
        biconomyBid = ticker.bid;
        biconomyAsk = ticker.ask;
        biconomyPrice = (ticker.ask + ticker.bid) / 2;
        logger.info(`Biconomy market price: ${biconomyPrice}, bid: ${biconomyBid}, ask: ${biconomyAsk}`);
      } catch (error) {
        logger.error('❌ Failed to fetch Biconomy market price:', error);
      }

      const executableBookSnapshot = await this.logExecutableBookSnapshot(lastPrice, biconomyBid, biconomyAsk);
      const executableMidPrice = executableBookSnapshot?.midPrice ?? 0;
      const executableBestBid = executableBookSnapshot?.bestBid ?? 0;
      const executableBestAsk = executableBookSnapshot?.bestAsk ?? 0;
      const sanitizedTickerQuotes = this.getSanitizedTickerQuotes({ bid: biconomyBid, ask: biconomyAsk });
      const executableSpreadPercent =
        executableBestBid > 0 && executableBestAsk > 0
          ? ((executableBestAsk - executableBestBid) / executableBestBid) * 100
          : Infinity;
      const executableSpreadCircuitBreakerPercent = Math.max(
        config.volumeStrategy.executableSpreadCircuitBreakerPercent,
        0
      );
      if (
        Number.isFinite(executableSpreadPercent) &&
        executableSpreadPercent > executableSpreadCircuitBreakerPercent
      ) {
        logger.warn(
          `🛑 Executable spread circuit breaker: ${executableSpreadPercent.toFixed(2)}% > ${executableSpreadCircuitBreakerPercent.toFixed(2)}%; pausing quote placement for this cycle.`
        );
        return;
      }
      const executableMidUsable =
        executableMidPrice > 0 &&
        Number.isFinite(executableSpreadPercent) &&
        executableSpreadPercent <= VolumeGenerationStrategy.MAX_EXECUTABLE_SPREAD_PERCENT;

      const washPriceReference = lastPrice;
      const { priceReference, source: placementPriceSource } = this.selectPlacementPriceReference(
        washPriceReference,
        executableMidPrice,
        executableMidUsable,
        biconomyPrice
      );

      if (placementPriceSource === 'EXECUTABLE_BOOK_MID') {
        logger.info(`🎯 Using executable orderbook mid-price for placements: ${priceReference.toExponential(4)} (wash reference remains DEX ${washPriceReference.toExponential(4)})`);
      } else if (placementPriceSource === 'CEX_TICKER_MID') {
        if (executableMidPrice > 0) {
          logger.warn(
            `⚠️  Executable orderbook spread too wide (${executableSpreadPercent.toFixed(2)}%), falling back to CEX ticker mid for placements: ${priceReference.toExponential(4)}`
          );
        } else {
          logger.warn(`⚠️  Executable orderbook mid unavailable, falling back to CEX ticker mid for placements: ${priceReference.toExponential(4)}`);
        }
      } else {
        logger.warn(`⚠️  No usable CEX price available, falling back to DEX reference for placements: ${washPriceReference.toExponential(4)}`);
      }

      this.updateInventoryMarkPrice(priceReference);

      logger.info('Using DEX price as reference for all wash trades.');
      const hasValidBiconomyReference = Number.isFinite(biconomyPrice) && biconomyPrice > 0;
      const dexCexDriftPercent = hasValidBiconomyReference
        ? (Math.abs(washPriceReference - biconomyPrice) / biconomyPrice) * 100
        : 0;
      const maxDexCexDriftPercent = Math.max(config.volumeStrategy.maxDexCexDriftPercent, 0);
      const canRunWashTradesByDrift =
        !config.volumeStrategy.pauseWashOnHighDrift ||
        !hasValidBiconomyReference ||
        dexCexDriftPercent <= maxDexCexDriftPercent;
      const quotePlacementDriftMode = this.selectQuotePlacementDriftMode(
        placementPriceSource,
        hasValidBiconomyReference,
        dexCexDriftPercent,
        maxDexCexDriftPercent
      );
      if (hasValidBiconomyReference) {
        logger.info(
          `📐 DEX/CEX drift: ${dexCexDriftPercent.toFixed(2)}% (limit ${maxDexCexDriftPercent.toFixed(2)}%)`
        );
      }
      if (config.volumeStrategy.pauseWashOnHighDrift && !canRunWashTradesByDrift) {
        logger.warn(
          `⏸️  Pausing wash trades this cycle: DEX/CEX drift ${dexCexDriftPercent.toFixed(2)}% exceeds ${maxDexCexDriftPercent.toFixed(2)}%`
        );
      }
      if (quotePlacementDriftMode.mode === 'CEX_ONLY') {
        logger.warn(
          `🛡️  Restricting live quoting to CEX-based prices this cycle: DEX/CEX drift ${dexCexDriftPercent.toFixed(2)}% exceeds ${maxDexCexDriftPercent.toFixed(2)}%`
        );
      }
      if (!quotePlacementDriftMode.allowQuotePlacements) {
        logger.warn(
          `⏸️  Pausing live quote placement this cycle: DEX fallback is blocked while drift ${dexCexDriftPercent.toFixed(2)}% exceeds ${maxDexCexDriftPercent.toFixed(2)}%`
        );
        return;
      }

      const dexAnchoredQuotePolicy = this.getDexAnchoredQuotePolicy(washPriceReference, biconomyPrice);
      if (config.volumeStrategy.dexAnchoredQuotingEnabled) {
        logger.info(
          `⚓ DEX-anchored policy: buys=${dexAnchoredQuotePolicy.allowBuys ? 'allowed' : 'blocked'} sells=${dexAnchoredQuotePolicy.allowSells ? 'allowed' : 'blocked'} buyRef=${dexAnchoredQuotePolicy.buyReference.toExponential(4)} sellRef=${dexAnchoredQuotePolicy.sellReference.toExponential(4)}`
        );
      }

      // Place and maintain the configured live-book targets for this deployment profile.
      const targetOrdersPerSide = this.getTargetOrdersPerSide();
      const targetBuyDepthUsd = this.getTargetBuyDepthUsd();
      const targetSellDepthUsd = this.getTargetSellDepthUsd();
      const maxPlacementsPerCycle = Math.max(
        2,
        Math.min(targetOrdersPerSide, Math.floor(config.volumeStrategy.orderFrequency / 4000))
      );
      const configuredWashReservedPlacements = Math.max(
        0,
        Math.floor(config.volumeStrategy.washReservedPlacementsPerCycle)
      );
      const washReservedPlacements = Math.min(
        configuredWashReservedPlacements,
        Math.max(maxPlacementsPerCycle - 2, 0)
      );
      const bookPlacementBudget = Math.max(maxPlacementsPerCycle - washReservedPlacements, 2);
      const hasExecutableTouchLevels = executableMidUsable && executableBestBid > 0 && executableBestAsk > 0;
      let placementsThisCycle = 0;
      const hasPlacementBudget = () => placementsThisCycle < maxPlacementsPerCycle;
      let cleanupCancelledCount = 0;
      // Always cleanup excess orders at the start of the cycle
      let openOrders = await this.exchange.getOpenOrders(this.symbol);
      let buyOrders = openOrders.filter(o => o.side === 'BUY');
      let sellOrders = openOrders.filter(o => o.side === 'SELL');
      logger.info(`📊 [PRE-CLEANUP] Current orders: ${buyOrders.length} buys, ${sellOrders.length} sells (target: ${targetOrdersPerSide} each)`);
      if (config.volumeStrategy.dexAnchoredQuotingEnabled && dexAnchoredQuotePolicy.allowSells) {
        const belowDexSells = sellOrders.filter(order => order.price < dexAnchoredQuotePolicy.sellReference);
        for (const order of belowDexSells) {
          logger.info(
            `[DEX-ANCHOR] Cancelling SELL below anchor: ${order.orderId} @ ${order.price.toExponential(4)} < ${dexAnchoredQuotePolicy.sellReference.toExponential(4)}`
          );
          await this.exchange.cancelOrder(this.symbol, order.orderId);
        }
        if (belowDexSells.length > 0) {
          openOrders = await this.exchange.getOpenOrders(this.symbol);
          buyOrders = openOrders.filter(o => o.side === 'BUY');
          sellOrders = openOrders.filter(o => o.side === 'SELL');
        }
      }
      if (buyOrders.length > targetOrdersPerSide) {
        // Sort by timestamp descending, keep newest 30
        const sortedBuys = buyOrders.sort((a, b) => b.timestamp - a.timestamp);
        const excessBuyOrders = sortedBuys.slice(targetOrdersPerSide);
        for (const order of excessBuyOrders) {
          logger.info(`[Cleanup] Cancelling excess BUY order: ${order.orderId}`);
          await this.exchange.cancelOrder(this.symbol, order.orderId);
          cleanupCancelledCount++;
        }
      }
      if (sellOrders.length > targetOrdersPerSide) {
        const sortedSells = sellOrders.sort((a, b) => b.timestamp - a.timestamp);
        const excessSellOrders = sortedSells.slice(targetOrdersPerSide);
        for (const order of excessSellOrders) {
          logger.info(`[Cleanup] Cancelling excess SELL order: ${order.orderId}`);
          await this.exchange.cancelOrder(this.symbol, order.orderId);
          cleanupCancelledCount++;
        }
      }
      // Re-fetch open orders after cleanup
      openOrders = await this.exchange.getOpenOrders(this.symbol);
      buyOrders = openOrders.filter(o => o.side === 'BUY');
      sellOrders = openOrders.filter(o => o.side === 'SELL');
      logger.info(`📊 [POST-CLEANUP] Orders: ${buyOrders.length} buys, ${sellOrders.length} sells (target: ${targetOrdersPerSide} each)`);

      const bookAlreadyFull = buyOrders.length >= targetOrdersPerSide && sellOrders.length >= targetOrdersPerSide;
      if (bookAlreadyFull && cleanupCancelledCount === 0) {
        const configuredRefreshPerSide = Math.max(
          Math.floor(config.volumeStrategy.quoteChurnRefreshPerSide),
          0
        );
        const refreshPerSide = Math.min(
          configuredRefreshPerSide,
          Math.max(Math.floor(bookPlacementBudget / 2), 1)
        );

        if (refreshPerSide > 0) {
          const oldestBuys = [...buyOrders]
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, refreshPerSide);
          const oldestSells = [...sellOrders]
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, refreshPerSide);

          for (const order of oldestBuys) {
            logger.info(`[Churn] Cancelling oldest BUY order for refresh: ${order.orderId}`);
            await this.exchange.cancelOrder(this.symbol, order.orderId);
          }
          for (const order of oldestSells) {
            logger.info(`[Churn] Cancelling oldest SELL order for refresh: ${order.orderId}`);
            await this.exchange.cancelOrder(this.symbol, order.orderId);
          }

          openOrders = await this.exchange.getOpenOrders(this.symbol);
          buyOrders = openOrders.filter(o => o.side === 'BUY');
          sellOrders = openOrders.filter(o => o.side === 'SELL');
          logger.info(`🔁 [CHURN] Refreshed quotes: ${buyOrders.length} buys, ${sellOrders.length} sells after oldest-order replacement.`);
        }
      }

      const missingBuyOrders = Math.max(targetOrdersPerSide - buyOrders.length, 0);
      const missingSellOrders = Math.max(targetOrdersPerSide - sellOrders.length, 0);
      const missingTotalOrders = missingBuyOrders + missingSellOrders;
      let buyPlacementCap = missingBuyOrders > 0 ? bookPlacementBudget : 0;
      let sellPlacementCap = missingSellOrders > 0 ? bookPlacementBudget : 0;

      if (missingBuyOrders > 0 && missingSellOrders > 0 && missingTotalOrders > 0) {
        buyPlacementCap = Math.max(1, Math.floor((bookPlacementBudget * missingBuyOrders) / missingTotalOrders));
        sellPlacementCap = Math.max(1, bookPlacementBudget - buyPlacementCap);
      }

      const sellBuyGap = sellOrders.length - buyOrders.length;
      const sellToBuyRatio = sellOrders.length / Math.max(buyOrders.length, 1);
      const lowBookSellHeavy = buyOrders.length <= 2 && sellOrders.length > buyOrders.length;
      const shouldPrioritizeBuys =
        lowBookSellHeavy || (
          sellBuyGap >= VolumeGenerationStrategy.SELL_IMBALANCE_GUARD_MIN_GAP &&
          sellToBuyRatio >= VolumeGenerationStrategy.SELL_IMBALANCE_GUARD_MIN_RATIO
        );

      if (shouldPrioritizeBuys) {
        sellPlacementCap = 0;
        if (missingBuyOrders > 0) {
          buyPlacementCap = Math.max(buyPlacementCap, bookPlacementBudget);
        }
        logger.warn(
          `⚖️  Sell-side imbalance guard active: openBook=${buyOrders.length} buys/${sellOrders.length} sells; prioritizing buy placements this cycle.`
        );
      }
      let shouldPrioritizeBuysForDepth = shouldPrioritizeBuys;

      let buyPlacementsThisCycle = 0;
      let sellPlacementsThisCycle = 0;
      const hasBuyPlacementBudget = () => hasPlacementBudget() && buyPlacementsThisCycle < buyPlacementCap;
      const hasSellPlacementBudget = () => hasPlacementBudget() && sellPlacementsThisCycle < sellPlacementCap;
      const inventorySkewPercent = this.getInventorySkewPercent();
      const skewedPriceReference = this.applyInventorySkewToQuotePrice(priceReference);

      if (inventorySkewPercent !== 0) {
        logger.info(
          `🧭 Inventory skew active: position=${this.currentPosition.toFixed(2)} shift=${(inventorySkewPercent * 100).toFixed(3)}% quoteRef=${priceReference.toExponential(4)} -> ${skewedPriceReference.toExponential(4)}`
        );
      }

      // --- Order Depth Logic ---
      // Place new orders using side-specific balance-aware sizing
      const balances = await this.exchange.getBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      const epwxBalance = balances.find(b => b.asset === 'EPWX');
      const availableUSDT = usdtBalance?.free || 0;
      const availableEPWX = epwxBalance?.free || 0;
      const buyReserveUsd = this.getIdleBalanceReserveUsd();
      const spendableBuyUsd = Math.max(availableUSDT - buyReserveUsd, 0);
      const executableDepth = this.calculateExecutableDepthUsd(executableBookSnapshot, priceReference);
      const adverseBuyGuard = this.evaluateAdverseBuyFillGuard(priceReference, targetBuyDepthUsd);
      const forceBuyPause = this.getForceBuyPause();
      const buyReactivationMode = this.getBuyReactivationMode();
      const buyReactivationGate = this.evaluateBuyReactivationGate(
        buyReactivationMode,
        placementPriceSource,
        executableSpreadPercent,
        sanitizedTickerQuotes?.spreadPercent,
        dexCexDriftPercent,
        maxDexCexDriftPercent,
        executableDepth,
        adverseBuyGuard.active
      );
      const buyBlockedByMarketQualityGate =
        !buyReactivationGate.allowBuys &&
        buyReactivationMode === 'auto' &&
        (
          buyReactivationGate.reason.includes('DEX/CEX drift') ||
          buyReactivationGate.reason.includes('spread')
        );
      const canPlaceReserveConstrainedBuys = spendableBuyUsd >= VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD;
      const canPlaceBuysThisCycle =
        canPlaceReserveConstrainedBuys &&
        !forceBuyPause &&
        buyReactivationGate.allowBuys &&
        dexAnchoredQuotePolicy.allowBuys;
      const canPlaceSellsThisCycle = dexAnchoredQuotePolicy.allowSells;
      const availableSellUsd = availableEPWX * priceReference;
      const baseBuySafeOrderSizeUSD = this.getBalanceAwareOrderUsdTarget(availableUSDT, targetOrdersPerSide, this.getBalanceUtilizationPercent());
      const buySizingDecision = this.resolveAutoBuySizingDecision(
        buyReactivationMode,
        buyReactivationGate,
        executableDepth
      );
      const buySafeOrderSizeUSD = canPlaceBuysThisCycle
        ? Math.max(this.getMinimumOrderUsdTarget(), baseBuySafeOrderSizeUSD * buySizingDecision.multiplier)
        : baseBuySafeOrderSizeUSD;
      const sellSafeOrderSizeUSD = this.getBalanceAwareOrderUsdTarget(availableSellUsd, targetOrdersPerSide, this.getBalanceUtilizationPercent());
      const washOrderSizeCapUsd = Math.max(config.volumeStrategy.washOrderSizeCapUsd, this.getMinimumOrderUsdTarget());
      const washSafeOrderSizeUSD = Math.min(
        Math.min(buySafeOrderSizeUSD, sellSafeOrderSizeUSD),
        washOrderSizeCapUsd
      );
      const washScaleThreshold = Math.max(config.volumeStrategy.washUsdtScaleThreshold, 1);
      const scaledWashPairs = Math.floor(availableUSDT / washScaleThreshold);
      const dynamicWashTradePairs = Math.min(
        Math.max(
          Math.floor(config.volumeStrategy.washBasePairsPerCycle) + scaledWashPairs,
          0
        ),
        Math.max(Math.floor(config.volumeStrategy.washMaxPairsPerCycle), 0)
      );
      logger.info(
        `🔧 Calculated balance-aware order sizes: BUY ~$${buySafeOrderSizeUSD.toFixed(2)} (USDT), SELL ~$${sellSafeOrderSizeUSD.toFixed(2)} (EPWX), WASH ~$${washSafeOrderSizeUSD.toFixed(2)} per order`
      );
      if (buyReactivationMode === 'auto') {
        logger.info(
          `🧪 Auto buy gates: depth buy=$${executableDepth.buyDepthUsd.toFixed(2)} sell=$${executableDepth.sellDepthUsd.toFixed(2)} | drift=${dexCexDriftPercent.toFixed(2)}% | sizing=${buySizingDecision.regime} (${buySizingDecision.multiplier.toFixed(2)}x)`
        );
      }
      logger.info(
        `🧮 Placement budgets: max=${maxPlacementsPerCycle}, book=${bookPlacementBudget}, reservedWash=${washReservedPlacements}, targetWashPairs=${dynamicWashTradePairs}`
      );

      if (adverseBuyGuard.active) {
        buyPlacementCap = 0;
        if (missingSellOrders > 0) {
          sellPlacementCap = Math.max(sellPlacementCap, bookPlacementBudget);
        }
        if (shouldPrioritizeBuysForDepth) {
          shouldPrioritizeBuysForDepth = false;
        }
        logger.warn(
          `🛑 Adverse-fill buy guard active: realFills BUY=${this.realBuyFills}, SELL=${this.realSellFills}, gap=${adverseBuyGuard.buyFillGap}, ratio=${adverseBuyGuard.buySellRatio.toFixed(2)}x, longInventory=$${adverseBuyGuard.longInventoryUsd.toFixed(2)} (limit $${adverseBuyGuard.inventoryLimitUsd.toFixed(2)}). Suppressing new BUY placements this cycle.`
        );
      }

      if (forceBuyPause) {
        buyPlacementCap = 0;
        if (sellPlacementCap === 0 && missingSellOrders > 0) {
          sellPlacementCap = Math.max(1, bookPlacementBudget);
          logger.info('⏭️  Restoring sell placement budget because BUY placements are policy-paused this cycle.');
        }
        if (shouldPrioritizeBuysForDepth) {
          shouldPrioritizeBuysForDepth = false;
          logger.info('⏭️  Buy-side prioritization is disabled this cycle because FORCE_BUY_PAUSE=true.');
        }
        logger.warn('🧯 BUY placements paused by policy: FORCE_BUY_PAUSE=true.');
      }

      if (!buyReactivationGate.allowBuys) {
        buyPlacementCap = 0;
        if (sellPlacementCap === 0 && missingSellOrders > 0) {
          sellPlacementCap = Math.max(1, bookPlacementBudget);
          logger.info('⏭️  Restoring sell placement budget because buy reactivation gate is blocking BUY placements this cycle.');
        }
        if (shouldPrioritizeBuysForDepth) {
          shouldPrioritizeBuysForDepth = false;
          logger.info('⏭️  Buy-side prioritization is disabled this cycle because buy reactivation gate is blocking BUY placements.');
        }
        logger.warn(`🧯 BUY placements paused by reactivation gate: ${buyReactivationGate.reason}.`);
      } else if (buyReactivationMode === 'auto') {
        logger.info(`✅ ${buyReactivationGate.reason}.`);
      }

      if (!canPlaceReserveConstrainedBuys) {
        logger.warn(
          `⚠️  Buy placements paused this cycle: spendable USDT $${spendableBuyUsd.toFixed(2)} is below minimum notional $${VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD.toFixed(2)} after reserve $${buyReserveUsd.toFixed(2)}.`
        );

        if (sellPlacementCap === 0 && missingSellOrders > 0) {
          sellPlacementCap = Math.max(1, bookPlacementBudget);
          logger.info('⏭️  Restoring sell placement budget because buy placements are reserve-constrained this cycle.');
        }

        if (shouldPrioritizeBuysForDepth) {
          shouldPrioritizeBuysForDepth = false;
          logger.info('⏭️  Buy-side prioritization is disabled this cycle because reserve-constrained buy placements are paused.');
        }
      }

      const shouldFreezeSellPlacementsBecauseNoSellTarget = targetSellDepthUsd <= 0 && !canPlaceBuysThisCycle;
      const shouldFreezeSellPlacements =
        shouldFreezeSellPlacementsBecauseNoSellTarget ||
        buyBlockedByMarketQualityGate;

      if (shouldFreezeSellPlacements) {
        const sellFreezeReason = shouldFreezeSellPlacementsBecauseNoSellTarget
          ? 'sell depth target is disabled while buys are gated'
          : 'buy reactivation gate blocked buys due to market-quality conditions';

        if (sellPlacementCap > 0) {
          logger.warn(`🛑 Freezing new sell placements this cycle: ${sellFreezeReason}.`);
        }

        sellPlacementCap = 0;
        shouldPrioritizeBuysForDepth = false;
      }

      let sellPlacementPriceReference = skewedPriceReference;
      let sellPlacementMode: 'PASSIVE' | 'EXCHANGE_BAND_FALLBACK' = 'PASSIVE';
      if (!shouldFreezeSellPlacements) {
        const sellClampProbePrice = this.getPassiveSeededQuotePrice(skewedPriceReference, 'SELL', 0);
        const sellClampProbeExecutablePrice = await this.clampPriceToLatestBand(sellClampProbePrice, 'SELL');
        if (this.isExtremeClampReprice(sellClampProbePrice, sellClampProbeExecutablePrice)) {
          sellPlacementPriceReference = sellClampProbeExecutablePrice;
          sellPlacementMode = 'EXCHANGE_BAND_FALLBACK';
          logger.warn(
            `⚠️  Sell placements using exchange-band fallback this cycle: passive sell anchor ${sellClampProbePrice.toExponential(4)} would clamp to ${sellClampProbeExecutablePrice.toExponential(4)} beyond the x${VolumeGenerationStrategy.MAX_CLAMP_REPRICE_RATIO.toFixed(2)} safety ratio.`
          );
        }
      }
      const allowSparseSellRecovery = !canPlaceBuysThisCycle;

      // Place one small top-touch order per side to improve fill discovery while keeping most quotes passive.
      if (hasExecutableTouchLevels) {
        const passiveTopTouchPrices = this.selectPassiveTopTouchPrices(executableBestBid, executableBestAsk);
        const topTouchBaseUsd = Math.max(
          this.getMinimumOrderUsdTarget(),
          Math.min(
            Math.min(buySafeOrderSizeUSD, sellSafeOrderSizeUSD),
            this.getEffectiveOrderUsdCap(Math.min(availableUSDT, availableSellUsd))
          )
        );

        if (canPlaceBuysThisCycle && hasBuyPlacementBudget() && passiveTopTouchPrices) {
          const buyTouchAnchor = config.volumeStrategy.dexAnchoredQuotingEnabled
            ? Math.min(passiveTopTouchPrices.buyPrice, dexAnchoredQuotePolicy.buyReference)
            : passiveTopTouchPrices.buyPrice;
          const buyTouchPrice = this.applyInventorySkewToQuotePrice(buyTouchAnchor);
          const buyTouchUsd = this.getDynamicOrderUsdTarget(topTouchBaseUsd);
          const buyTouchRawAmount = buyTouchUsd / buyTouchPrice;
          const buyTouchAmount = this.normalizeOrderAmount(quantizeToStepSize(buyTouchRawAmount, this.stepSize), buyTouchPrice, availableUSDT);
          if (buyTouchAmount !== null && this.isValidOrderAmount(buyTouchAmount, buyTouchPrice)) {
            logger.info(`🎯 Placing passive top-touch BUY: ${buyTouchAmount} EPWX @ ${buyTouchPrice.toExponential(4)} (bestBid)`);
            const topTouchBuyOrderId = await this.placeBuyOrder(
              buyTouchPrice,
              buyTouchAmount,
              false,
              config.volumeStrategy.dexAnchoredQuotingEnabled ? dexAnchoredQuotePolicy.buyReference : undefined
            );
            if (topTouchBuyOrderId) {
              placementsThisCycle++;
              buyPlacementsThisCycle++;
            }
          }
        }

        if (canPlaceSellsThisCycle && hasSellPlacementBudget() && !shouldPrioritizeBuysForDepth && passiveTopTouchPrices) {
          const sellTouchAnchorPrice = sellPlacementMode === 'EXCHANGE_BAND_FALLBACK'
            ? sellPlacementPriceReference
            : (config.volumeStrategy.dexAnchoredQuotingEnabled
              ? Math.max(passiveTopTouchPrices.sellPrice, dexAnchoredQuotePolicy.sellReference)
              : passiveTopTouchPrices.sellPrice);
          const sellTouchPrice = this.applyInventorySkewToQuotePrice(sellTouchAnchorPrice);
          const sellTouchUsd = this.getDynamicOrderUsdTarget(topTouchBaseUsd);
          const sellTouchRawAmount = sellTouchUsd / sellTouchPrice;
          const sellTouchAmount = this.normalizeOrderAmount(quantizeToStepSize(sellTouchRawAmount, this.stepSize), sellTouchPrice, availableSellUsd);
          if (sellTouchAmount !== null && this.isValidOrderAmount(sellTouchAmount, sellTouchPrice)) {
            logger.info(`🎯 Placing passive top-touch SELL: ${sellTouchAmount} EPWX @ ${sellTouchPrice.toExponential(4)} (bestAsk)`);
            const topTouchSellOrderId = await this.placeSellOrder(sellTouchPrice, sellTouchAmount);
            if (topTouchSellOrderId) {
              placementsThisCycle++;
              sellPlacementsThisCycle++;
            }
          }
        }

        if (placementsThisCycle > 0) {
          openOrders = await this.exchange.getOpenOrders(this.symbol);
          buyOrders = openOrders.filter(o => o.side === 'BUY');
          sellOrders = openOrders.filter(o => o.side === 'SELL');
          logger.info(`📌 After top-touch orders: ${buyOrders.length} buys, ${sellOrders.length} sells`);

          const sellBuyGapAfterTopTouch = sellOrders.length - buyOrders.length;
          const sellToBuyRatioAfterTopTouch = sellOrders.length / Math.max(buyOrders.length, 1);
          const lowBookSellHeavyAfterTopTouch = buyOrders.length <= 2 && sellOrders.length > buyOrders.length;
          const shouldPrioritizeBuysAfterTopTouch =
            canPlaceBuysThisCycle &&
            (
              lowBookSellHeavyAfterTopTouch || (
                sellBuyGapAfterTopTouch >= VolumeGenerationStrategy.SELL_IMBALANCE_GUARD_MIN_GAP &&
                sellToBuyRatioAfterTopTouch >= VolumeGenerationStrategy.SELL_IMBALANCE_GUARD_MIN_RATIO
              )
            );

          if (shouldPrioritizeBuysAfterTopTouch && !shouldPrioritizeBuysForDepth) {
            shouldPrioritizeBuysForDepth = true;
            logger.warn(
              `⚖️  Sell-side imbalance guard activated after top-touch refresh: openBook=${buyOrders.length} buys/${sellOrders.length} sells; suppressing additional sell placements this cycle.`
            );
          }
        }
      }

      const buyBandReference = config.volumeStrategy.dexAnchoredQuotingEnabled
        ? dexAnchoredQuotePolicy.buyReference
        : skewedPriceReference;
      const sellBandReference = config.volumeStrategy.dexAnchoredQuotingEnabled
        ? dexAnchoredQuotePolicy.sellReference
        : sellPlacementPriceReference;
      const { minBuyPrice, maxBuyPrice } = this.getPassiveQuoteBands(buyBandReference);
      const { minSellPrice, maxSellPrice } = this.getPassiveQuoteBands(sellBandReference);
      const buyBandLabel = `${((minBuyPrice / skewedPriceReference) * 100).toFixed(2)}%-${((maxBuyPrice / skewedPriceReference) * 100).toFixed(2)}%`;
      const sellBandLabel = `${((minSellPrice / sellPlacementPriceReference) * 100).toFixed(2)}%-${((maxSellPrice / sellPlacementPriceReference) * 100).toFixed(2)}%`;

      const buyDepth = buyOrders
        .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
        .reduce((sum, o) => sum + o.price * o.amount, 0);
      const sellDepth = sellOrders
        .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
        .reduce((sum, o) => sum + o.price * o.amount, 0);

      logger.info(`📏 Buy depth (${buyBandLabel}): $${buyDepth.toFixed(2)} / $${targetBuyDepthUsd.toFixed(2)} | Sell depth (${sellBandLabel}): $${sellDepth.toFixed(2)} / $${targetSellDepthUsd.toFixed(2)}`);


      // Place additional buy orders if needed to reach the configured buy-side depth target.
      let buyDepthShortfall = targetBuyDepthUsd - buyDepth;
      if (buyDepthShortfall > 0 && !canPlaceReserveConstrainedBuys) {
        logger.info(
          `⏭️  Skipping buy-depth additions this cycle: spendable USDT $${spendableBuyUsd.toFixed(2)} is below minimum notional after reserve.`
        );
      }

      if (buyDepthShortfall > 0 && forceBuyPause) {
        logger.info('⏭️  Skipping buy-depth additions this cycle: FORCE_BUY_PAUSE=true.');
      }

      if (buyDepthShortfall > 0 && canPlaceBuysThisCycle) {
        logger.info(`🟢 Need to add $${buyDepthShortfall.toFixed(2)} buy orders in ${buyBandLabel} of Mid-Price (Business Support)`);
        // Place as many orders as needed to fill the gap, using safe order size
        let remaining = buyDepthShortfall;
        let supportBuysPlaced = 0;
        const maxSupportBuys = Math.max(targetOrdersPerSide - buyOrders.length, 0);
        while (remaining > 0 && supportBuysPlaced < maxSupportBuys && hasBuyPlacementBudget()) {
          const buyPrice = minBuyPrice + ((maxBuyPrice - minBuyPrice) * Math.random());
          const targetOrderUsd = this.getDynamicOrderUsdTarget(buySafeOrderSizeUSD, remaining);
          let amount = targetOrderUsd / buyPrice;
          amount = quantizeToStepSize(amount, this.stepSize);
          amount = Math.max(this.minQty, amount);
          if (!this.isValidOrderAmount(amount, buyPrice)) {
            logger.warn(`⚠️  Skipping buy order: invalid amount (${amount}) or amount * price (${amount * buyPrice}) < ${VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD} USDT.`);
            break;
          }
          const buyOrderAmount = this.normalizeOrderAmount(amount, buyPrice, availableUSDT);
          if (buyOrderAmount === null || !this.isValidOrderAmount(buyOrderAmount, buyPrice)) {
            logger.warn(`⚠️  Skipping depth buy order after normalization: amount=${amount}, minQty=${this.minQty}`);
            break;
          }
          logger.info(`🟢 Placing depth buy order: ${buyOrderAmount} EPWX @ ${buyPrice.toExponential(4)} (${buyBandLabel} of Mid-Price)`);
          const buyOrderId = await this.placeBuyOrder(
            buyPrice,
            buyOrderAmount,
            false,
            config.volumeStrategy.dexAnchoredQuotingEnabled ? dexAnchoredQuotePolicy.buyReference : undefined
          );
          if (!buyOrderId) {
            break;
          }
          placementsThisCycle++;
          buyPlacementsThisCycle++;
          supportBuysPlaced++;
          remaining -= buyPrice * buyOrderAmount;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      // Place additional sell orders if needed to reach the configured sell-side depth target.
      let sellDepthShortfall = targetSellDepthUsd - sellDepth;
      if (sellDepthShortfall > 0) {
        if (shouldPrioritizeBuysForDepth) {
          logger.info('⏭️  Skipping depth sell additions this cycle because buy-side replenishment is prioritized.');
        }
      }

      if (sellDepthShortfall > 0 && canPlaceSellsThisCycle && !shouldPrioritizeBuysForDepth) {
        if (sellPlacementMode === 'EXCHANGE_BAND_FALLBACK') {
          logger.info(
            `🔁 Using exchange-band fallback sell pricing this cycle to keep sell depth building inside the latest-price band.`
          );
        }
        logger.info(`🔴 Need to add $${sellDepthShortfall.toFixed(2)} sell orders in ${sellBandLabel} of Fallback Mid-Price (Business Support)`);
        let remaining = sellDepthShortfall;
        let supportSellsPlaced = 0;
        const maxSupportSells = Math.max(targetOrdersPerSide - sellOrders.length, 0);
        while (remaining > 0 && supportSellsPlaced < maxSupportSells && hasSellPlacementBudget()) {
          const projectedBuyCount = buyOrders.length + buyPlacementsThisCycle;
          const projectedSellCount = sellOrders.length + sellPlacementsThisCycle;
          if (!allowSparseSellRecovery && projectedBuyCount <= 2 && projectedSellCount >= projectedBuyCount) {
            logger.info(
              `⏭️  Stopping depth sell additions: projected openBook=${projectedBuyCount} buys/${projectedSellCount} sells in a sparse cycle.`
            );
            break;
          }

          const sellPrice = minSellPrice + ((maxSellPrice - minSellPrice) * Math.random());
          const targetOrderUsd = this.getDynamicOrderUsdTarget(sellSafeOrderSizeUSD, remaining);
          let amount = targetOrderUsd / sellPrice;
          amount = quantizeToStepSize(amount, this.stepSize);
          amount = Math.max(this.minQty, amount);
          if (!this.isValidOrderAmount(amount, sellPrice)) {
            logger.warn(`⚠️  Skipping sell order: invalid amount (${amount})`);
            break;
          }
          const sellOrderAmount = this.normalizeOrderAmount(amount, sellPrice, availableSellUsd);
          if (sellOrderAmount === null || !this.isValidOrderAmount(sellOrderAmount, sellPrice)) {
            logger.warn(`⚠️  Skipping depth sell order after normalization: amount=${amount}, minQty=${this.minQty}`);
            break;
          }
          logger.info(`🔴 Placing depth sell order: ${sellOrderAmount} EPWX @ ${sellPrice.toExponential(4)} (${sellBandLabel} of Mid-Price)`);
          const sellOrderId = await this.placeSellOrder(sellPrice, sellOrderAmount);
          if (!sellOrderId) {
            break;
          }
          placementsThisCycle++;
          sellPlacementsThisCycle++;
          supportSellsPlaced++;
          remaining -= sellPrice * sellOrderAmount;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      openOrders = await this.exchange.getOpenOrders(this.symbol);
      buyOrders = openOrders.filter(o => o.side === 'BUY');
      sellOrders = openOrders.filter(o => o.side === 'SELL');
      const bookSeeded = buyOrders.length >= targetOrdersPerSide && sellOrders.length >= targetOrdersPerSide;

      // 1. Maintain exactly 30 buy and 30 sell orders at staggered prices for book depth
      if (buyOrders.length < targetOrdersPerSide && hasBuyPlacementBudget() && canPlaceBuysThisCycle) {
        const needBuys = targetOrdersPerSide - buyOrders.length;
        for (let i = 0; i < needBuys && hasBuyPlacementBudget(); i++) {
          const buyPrice = this.getPassiveSeededQuotePrice(skewedPriceReference, 'BUY', i);
          const buyOrderUsdTarget = this.getDynamicOrderUsdTarget(buySafeOrderSizeUSD);
          let rawAmount = buyOrderUsdTarget / buyPrice;
          let amount = quantizeToStepSize(rawAmount, this.stepSize);
          logger.info(`[ORDER DEBUG] Book-depth buy: rawAmount=${rawAmount}, quantized=${amount}, stepSize=${this.stepSize}, minQty=${this.minQty}, price=${buyPrice}`);
          if (!this.isValidOrderAmount(amount, buyPrice) || ((amount / this.stepSize) % 1 !== 0)) {
            logger.warn(`⚠️  Skipping book-depth buy order: invalid quantized amount (${amount}), raw (${rawAmount}), stepSize=${this.stepSize}, minQty=${this.minQty}`);
            continue;
          }
          const bookBuyAmount = this.normalizeOrderAmount(amount, buyPrice, availableUSDT);
          if (bookBuyAmount === null) {
            logger.warn(`⚠️  Skipping book-depth buy after normalization: amount=${amount}, minQty=${this.minQty}`);
            continue;
          }
          logger.info(`[${i+1}/${needBuys}] Placing book-depth buy order: ${bookBuyAmount} EPWX @ ${buyPrice.toExponential(4)} [Book Depth]`);
          const bookBuyOrderId = await this.placeBuyOrder(
            buyPrice,
            bookBuyAmount,
            false,
            config.volumeStrategy.dexAnchoredQuotingEnabled ? dexAnchoredQuotePolicy.buyReference : undefined
          );
          if (!bookBuyOrderId) {
            break;
          }
          placementsThisCycle++;
          buyPlacementsThisCycle++;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      if (sellOrders.length < targetOrdersPerSide && canPlaceSellsThisCycle && hasSellPlacementBudget() && !shouldPrioritizeBuysForDepth) {
        const needSells = targetOrdersPerSide - sellOrders.length;
        for (let i = 0; i < needSells && hasSellPlacementBudget(); i++) {
          const projectedBuyCount = buyOrders.length + buyPlacementsThisCycle;
          const projectedSellCount = sellOrders.length + sellPlacementsThisCycle;
          if (!allowSparseSellRecovery && projectedBuyCount <= 2 && projectedSellCount >= projectedBuyCount) {
            logger.info(
              `⏭️  Skipping book-depth sell additions: projected openBook=${projectedBuyCount} buys/${projectedSellCount} sells in a sparse cycle.`
            );
            break;
          }

          const sellPrice = this.getPassiveSeededQuotePrice(sellBandReference, 'SELL', i);
          const sellOrderUsdTarget = this.getDynamicOrderUsdTarget(sellSafeOrderSizeUSD);
          let rawAmount = sellOrderUsdTarget / sellPrice;
          let amount = quantizeToStepSize(rawAmount, this.stepSize);
          logger.info(`[ORDER DEBUG] Book-depth sell: rawAmount=${rawAmount}, quantized=${amount}, stepSize=${this.stepSize}, minQty=${this.minQty}, price=${sellPrice}`);
          if (!this.isValidOrderAmount(amount, sellPrice) || ((amount / this.stepSize) % 1 !== 0)) {
            logger.warn(`⚠️  Skipping book-depth sell order: invalid quantized amount (${amount}), raw (${rawAmount}), stepSize=${this.stepSize}, minQty=${this.minQty}`);
            continue;
          }
          const bookSellAmount = this.normalizeOrderAmount(amount, sellPrice, availableSellUsd);
          if (bookSellAmount === null) {
            logger.warn(`⚠️  Skipping book-depth sell after normalization: amount=${amount}, minQty=${this.minQty}`);
            continue;
          }
          logger.info(`[${i+1}/${needSells}] Placing book-depth sell order: ${bookSellAmount} EPWX @ ${sellPrice.toExponential(4)} [Book Depth]`);
          const bookSellOrderId = await this.placeSellOrder(sellPrice, bookSellAmount);
          if (!bookSellOrderId) {
            break;
          }
          placementsThisCycle++;
          sellPlacementsThisCycle++;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      // 2. Place a configurable number of matching buy/sell orders for wash trading (fills/volume)
      const remainingPlacementSlots = Math.max(maxPlacementsPerCycle - placementsThisCycle, 0);
      const washPairsByRemainingSlots = Math.floor(remainingPlacementSlots / 2);
      const reservedWashSlotsLeft = Math.max(washReservedPlacements - Math.max(placementsThisCycle - bookPlacementBudget, 0), 0);
      const washPairsByReservedBudget = Math.floor(reservedWashSlotsLeft / 2);
      const washDecision = this.resolveWashTradeDecision({
        canRunWashTradesByDrift,
        dexCexDriftPercent,
        executableSpreadPercent,
        adverseBuyGuardActive: adverseBuyGuard.active,
        forceBuyPause,
        dynamicWashTradePairs,
      });
      const washFeatureEnabled = washDecision.enabled;
      const washTradePairs = washFeatureEnabled
        ? Math.min(
            washDecision.maxPairs,
            Math.max(washPairsByRemainingSlots, 0),
            Math.max(washPairsByReservedBudget, 0)
          )
        : 0;
      this.washTradePairsActive = this.washTradePairsActive.filter(pair =>
        !this.settledWashOrderIds.has(pair.buyOrderId) && !this.settledWashOrderIds.has(pair.sellOrderId)
      );
      if (!washFeatureEnabled) {
        logger.info(`⏭️  Wash trades disabled this cycle: ${washDecision.reason}`);
      }
      if (!bookSeeded) {
        logger.info(`⏭️  Deferring wash trades until the order book is seeded (${buyOrders.length}/${targetOrdersPerSide} buys, ${sellOrders.length}/${targetOrdersPerSide} sells)`);
      }
      if (bookSeeded && washTradePairs === 0) {
        logger.info('⏭️  No wash trades this cycle because wash placement budget is exhausted.');
      }
      for (let i = 0; i < washTradePairs && bookSeeded && placementsThisCycle <= maxPlacementsPerCycle - 2; i++) {
        const matchPrice = washPriceReference;
        const washOrderUsdTarget = this.getDynamicOrderUsdTarget(washSafeOrderSizeUSD);
        let rawAmount = washOrderUsdTarget / matchPrice;
        let amount = quantizeToStepSize(rawAmount, this.stepSize);
        logger.info(`[ORDER DEBUG] Wash trade: rawAmount=${rawAmount}, quantized=${amount}, stepSize=${this.stepSize}, minQty=${this.minQty}, price=${matchPrice}`);
        if (!this.isValidOrderAmount(amount, matchPrice) || ((amount / this.stepSize) % 1 !== 0)) {
          logger.warn(`⚠️  Skipping wash trade buy/sell: invalid quantized amount (${amount}), raw (${rawAmount}), stepSize=${this.stepSize}, minQty=${this.minQty}`);
          continue;
        }
        const washAmount = this.normalizeOrderAmount(amount, matchPrice, Math.min(availableUSDT, availableEPWX * matchPrice));
        if (washAmount === null) {
          logger.warn(`⚠️  Skipping wash trade after normalization: amount=${amount}, minQty=${this.minQty}`);
          continue;
        }
        logger.info(`[Wash ${i+1}/${washTradePairs}] Placing matching BUY/SELL: ${washAmount} EPWX @ ${matchPrice.toExponential(4)} [Wash Trade]`);
        const buyOrderId = await this.placeBuyOrder(matchPrice, washAmount, true);
        const sellOrderId = await this.placeSellOrder(matchPrice, washAmount, true);
        if (buyOrderId && sellOrderId) {
          placementsThisCycle += 2;
          this.washTradePairsActive.push({ buyOrderId, sellOrderId, price: matchPrice, amount });
          logger.info(`[Wash Pair] Tracked: BUY ${buyOrderId}, SELL ${sellOrderId} @ ${matchPrice.toFixed(6)} (${amount.toFixed(2)} EPWX)`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!hasPlacementBudget()) {
        logger.info(`⏭️  Placement budget reached for this cycle (${placementsThisCycle}/${maxPlacementsPerCycle}); remaining depth will be added next cycle.`);
      }
      // Final check: cancel excess orders after all placements (keep only newest 30 per side)
      openOrders = await this.exchange.getOpenOrders(this.symbol);
      buyOrders = openOrders.filter(o => o.side === 'BUY');
      sellOrders = openOrders.filter(o => o.side === 'SELL');
      if (buyOrders.length > targetOrdersPerSide) {
        // Sort by timestamp descending, keep newest 30
        const sortedBuys = buyOrders.sort((a, b) => b.timestamp - a.timestamp);
        const excessBuyOrders = sortedBuys.slice(targetOrdersPerSide);
        for (const order of excessBuyOrders) {
          logger.info(`[Cleanup] Cancelling excess BUY order: ${order.orderId}`);
          await this.exchange.cancelOrder(this.symbol, order.orderId);
        }
      }
      if (sellOrders.length > targetOrdersPerSide) {
        const sortedSells = sellOrders.sort((a, b) => b.timestamp - a.timestamp);
        const excessSellOrders = sortedSells.slice(targetOrdersPerSide);
        for (const order of excessSellOrders) {
          logger.info(`[Cleanup] Cancelling excess SELL order: ${order.orderId}`);
          await this.exchange.cancelOrder(this.symbol, order.orderId);
        }
      }

      this.volumeStats.lastOrderTime = Date.now();
    } catch (error) {
      logger.error('💥 Unexpected error in placeVolumeOrders:', error);
    } finally {
      this.isPlacingOrders = false;
    }
  }

  private async fillOrderBook(
    lastPrice: number,
    needBuys: number,
    needSells: number,
    priceSource: string,
    biconomyBid: number,
    biconomyAsk: number
  ): Promise<void> {
    logger.info(`📚 fillOrderBook called: placing ${needBuys} buys and ${needSells} sells`);
    
    // Check available balance
    const balances = await this.exchange.getBalances();
    const usdtBalance = balances.find(b => b.asset === 'USDT');
    const epwxBalance = balances.find(b => b.asset === 'EPWX');
    const availableUSDT = usdtBalance?.free || 0;
    const availableEPWX = epwxBalance?.free || 0;
    const availableSellUsd = availableEPWX * lastPrice;
    
    logger.info(`💰 Available USDT balance: $${availableUSDT.toFixed(2)}`);
    
    // If USDT is very low, skip filling but don't block wash trades
    if (availableUSDT < 0.01) {
      logger.warn(`⚠️  Insufficient USDT balance for new orders (have $${availableUSDT.toFixed(2)})`);
      // Still allow wash trading with very low balances
    }
    
    // Calculate side-specific safe order size from current balances
    const buySafeOrderSizeUSD = this.getBalanceAwareOrderUsdTarget(availableUSDT, Math.max(needBuys, 1), 0.92);
    const sellSafeOrderSizeUSD = this.getBalanceAwareOrderUsdTarget(availableSellUsd, Math.max(needSells, 1), 0.92);
    logger.info(
      `🔧 Calculated balance-aware order sizes: BUY ~$${buySafeOrderSizeUSD.toFixed(2)} (USDT), SELL ~$${sellSafeOrderSizeUSD.toFixed(2)} (EPWX) per order`
    );
    
    const targetSpread = 0.003; // 0.3% spread around last price
    
    // Place buy orders with staggered prices
    if (needBuys > 0) {
      for (let i = 0; i < needBuys; i++) {
        let buyPrice;
        if (priceSource === 'Biconomy' && biconomyBid > 0) {
          buyPrice = biconomyBid * (1 - targetSpread - (i * 0.0001)); // Just below bid
        } else {
          buyPrice = lastPrice * (1 - targetSpread - (i * 0.0001));
        }
        const buyOrderUsdTarget = this.getDynamicOrderUsdTarget(buySafeOrderSizeUSD);
        const amount = buyOrderUsdTarget / buyPrice;
        const normalizedBuyAmount = this.normalizeOrderAmount(amount);
        if (normalizedBuyAmount === null) {
          logger.warn(`⚠️  Skipping fillOrderBook buy after normalization: amount=${amount}, minQty=${this.minQty}`);
          continue;
        }
        logger.info(`🛒 [${i+1}/${needBuys}] Placing buy order: ${normalizedBuyAmount} EPWX @ ${buyPrice.toExponential(4)} (~$${buyOrderUsdTarget.toFixed(2)}) [Source: ${priceSource}]`);
        await this.placeBuyOrder(buyPrice, normalizedBuyAmount);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } else {
      logger.info('No buy orders needed this cycle.');
    }

    // Place sell orders with staggered prices
    if (needSells > 0) {
      for (let i = 0; i < needSells; i++) {
        let sellPrice;
        if (priceSource === 'Biconomy' && biconomyAsk > 0) {
          sellPrice = biconomyAsk * (1 + targetSpread + (i * 0.0001)); // Just above ask
        } else {
          sellPrice = lastPrice * (1 + targetSpread + (i * 0.0001));
        }
        const sellOrderUsdTarget = this.getDynamicOrderUsdTarget(sellSafeOrderSizeUSD);
        let amount = sellOrderUsdTarget / sellPrice;
        const normalizedSellAmount = this.normalizeOrderAmount(amount);
        if (normalizedSellAmount === null) {
          logger.warn(`⚠️  Skipping fillOrderBook sell after normalization: amount=${amount}, minQty=${this.minQty}`);
          continue;
        }
        logger.info(`💰 [${i+1}/${needSells}] Placing sell order: ${normalizedSellAmount} EPWX @ ${sellPrice.toExponential(4)} (~$${sellOrderUsdTarget.toFixed(2)}) [Source: ${priceSource}]`);
        await this.placeSellOrder(sellPrice, normalizedSellAmount);
        logger.info(`✅ Sell order placed: ${normalizedSellAmount} EPWX @ ${sellPrice.toExponential(4)} [Source: ${priceSource}]`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } else {
      logger.info('No sell orders needed this cycle.');
    }

    logger.info(`✅ fillOrderBook complete: placed ${needBuys} buys and ${needSells} sells [Source: ${priceSource}]`);
  }

  private async executeWashTrade(lastPrice: number): Promise<void> {
    try {
      // Check available USDT and EPWX for wash trade
      const balances = await this.exchange.getBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      const epwxBalance = balances.find(b => b.asset === 'EPWX');
      const availableUSDT = usdtBalance?.free || 0;
      const availableEPWX = epwxBalance?.free || 0;
      if (availableUSDT < 0.01 || availableEPWX < 0.01) {
        logger.warn(`⚠️  Cannot execute wash trade - insufficient balance (USDT: $${availableUSDT.toFixed(2)}, EPWX: ${availableEPWX.toFixed(2)})`);
        return;
      }

      // Fetch the current market price (midpoint of best bid/ask)
      let matchPrice = lastPrice;
      try {
        const ticker = await this.exchange.getTicker(this.symbol);
        if (ticker && ticker.bid > 0 && ticker.ask > 0) {
          matchPrice = (ticker.bid + ticker.ask) / 2;
        }
      } catch (error) {
        logger.warn('Could not fetch ticker for exact match, using lastPrice.');
      }

      // Determine the maximum possible size for both buy and sell (in EPWX)
      const maxUSD = this.getDynamicOrderUsdTarget(Math.min(availableUSDT, 5));
      let amount = maxUSD / matchPrice;
      if (amount > availableEPWX) {
        amount = availableEPWX;
      }
      if (amount * matchPrice > availableUSDT) {
        amount = availableUSDT / matchPrice;
      }
      if (amount < 0.01) {
        logger.warn(`⚠️  Wash trade amount too small: ${amount}`);
        return;
      }

      logger.info(`🔄 Exact match wash trade: Buy & Sell ${amount.toFixed(4)} EPWX @ $${matchPrice.toExponential(4)}`);
      // Place buy and sell orders at the exact same price and size
      const normalizedAmount = this.normalizeOrderAmount(amount);
      if (normalizedAmount === null || !this.isValidOrderAmount(normalizedAmount, matchPrice)) {
        logger.warn(`⚠️  Skipping exact match wash trade buy: amount (${amount}) * price (${matchPrice}) < minimum required for ${VolumeGenerationStrategy.MIN_ORDER_NOTIONAL_USD} USDT.`);
        return;
      }
      await this.placeBuyOrder(matchPrice, normalizedAmount);
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.placeSellOrder(matchPrice, normalizedAmount);
      const volumeGenerated = 2 * (normalizedAmount * matchPrice);
      logger.info(`✅ Exact match wash trade complete! Volume: $${volumeGenerated.toFixed(2)}, Cost: ~$0 (0% fees)`);
    } catch (error) {
      logger.error('Error in wash trade:', error);
    }
  }

  protected async placeBuyOrder(
    price: number,
    amount: number,
    isWashTrade: boolean = false,
    maxPriceAnchor?: number
  ): Promise<string | void> {
    try {
      if (this.getForceBuyPause()) {
        logger.info('⏭️  Skipping buy order: FORCE_BUY_PAUSE=true.');
        return;
      }

      if (this.getBuyReactivationMode() === 'off') {
        logger.info('⏭️  Skipping buy order: BUY_REACTIVATION_MODE=off.');
        return;
      }

      // Check available USDT before placing order
      const balances = await this.exchange.getBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      const availableUSDT = usdtBalance?.free || 0;
      const normalizedAmount = this.applyOrderAmountCap(Math.floor(amount), 'BUY', price, availableUSDT);
      if (!this.isRunning || !Number.isFinite(price) || !Number.isFinite(normalizedAmount) || normalizedAmount < this.minQty) {
        logger.warn(`⚠️  Skipping buy order before placement: running=${this.isRunning}, amount=${normalizedAmount}, minQty=${this.minQty}, price=${price}`);
        return;
      }

      const requestedPrice = price;
      const requestedAmount = normalizedAmount;

      const clampedPrice = await this.clampPriceToLatestBand(price);
      if (clampedPrice !== price) {
        logger.warn(
          `⚠️  Clamping buy price from ${price.toExponential(4)} to ${clampedPrice.toExponential(4)} to stay within the latest-price band`
        );
        price = clampedPrice;
      }

      if (this.isExtremeClampReprice(requestedPrice, price)) {
        logger.warn(
          `⚠️  Buy price would extreme-clamp from ${requestedPrice.toExponential(4)} to ${price.toExponential(4)}; using exchange-band fallback buy pricing this cycle.`
        );
      }

      if (!isWashTrade && Number.isFinite(maxPriceAnchor) && maxPriceAnchor! > 0 && price > maxPriceAnchor!) {
        logger.info(
          `⚓ Capping buy price at DEX anchor: ${price.toExponential(4)} -> ${maxPriceAnchor!.toExponential(4)}`
        );
        price = maxPriceAnchor!;
      }

      if (!isWashTrade && await this.wouldCrossOpenBook('BUY', price)) {
        logger.warn(`🛑 Skipping BUY at ${price.toExponential(4)} because it would cross the open ask book.`);
        return;
      }

      const executableAmount = this.recalculateExecutableOrderAmount('BUY', requestedPrice, requestedAmount, price, availableUSDT, 0);
      if (executableAmount === null) {
        logger.warn(
          `⚠️  Skipping buy order after repricing: requested=${requestedAmount.toFixed(2)} @ ${requestedPrice.toExponential(4)}, executable=${price.toExponential(4)}, available=$${availableUSDT.toFixed(2)}, reserve=$${this.getIdleBalanceReserveUsd().toFixed(2)}`
        );
        return;
      }

      if (executableAmount !== normalizedAmount) {
        logger.warn(
          `⚠️  Reducing buy amount from ${normalizedAmount.toLocaleString()} to ${executableAmount.toLocaleString()} after price clamp to respect the reserve and executable notional`
        );
      }

      amount = executableAmount;

      const orderValue = amount * price;
      const spendableUSDT = Math.max(availableUSDT - this.getIdleBalanceReserveUsd(), 0);
      if (orderValue > spendableUSDT) {
        logger.warn(`⚠️  Skipping buy order: requested $${orderValue.toFixed(2)} > spendable $${spendableUSDT.toFixed(2)} after reserve`);
        return;
      }
      if (!this.isRunning) {
        logger.warn(`⚠️  Aborting buy order after balance check because the bot is stopping: amount=${amount}, price=${price}`);
        return;
      }
      logger.debug(`Attempting to place buy order: ${amount.toFixed(2)} @ ${price.toExponential(4)}`);
      const order = await this.exchange.placeOrder(
        this.symbol,
        'BUY',
        'LIMIT',
        amount,
        price
      );
      if (!order) {
        logger.error('Buy order placement returned undefined');
        return;
      }
      if (!this.isRunning) {
        logger.warn(`⚠️  Cancelling buy order ${order.orderId} because it was placed during shutdown.`);
        await this.exchange.cancelOrder(this.symbol, order.orderId);
        return;
      }
      this.activeOrders.set(order.orderId, order);
      this.orderPrices.set(order.orderId, { side: 'BUY', price });
      this.volumeStats.orderCount++;
      logger.info(`✅ Buy order placed: ${amount.toLocaleString()} EPWX @ $${price.toExponential(4)}`);
      void this.logPostPlacementOrderState(order.orderId, 'BUY', price);

      // Poll for fills after placing order
      void this.pollOrderFills(order.orderId, 'BUY', isWashTrade);
      return order.orderId;
    } catch (error) {
      logger.error('Error placing buy order:', error);
    }
  }

  protected async placeSellOrder(price: number, amount: number, isWashTrade: boolean = false): Promise<string | void> {
    try {
      const referencePrice = price; // Save original reference before any adjustments
      
      // EMERGENCY SHORT POSITION BRAKE: Refuse sells if position is dangerously short
      const maxShortPosition = -config.marketMaking.maxPositionSize * 0.9; // Allow 90% of max as short
      if (this.currentPosition < maxShortPosition) {
        logger.error(
          `🚨 EMERGENCY BRAKE: Position ${this.currentPosition.toFixed(2)} is dangerously short (< ${maxShortPosition.toFixed(2)}). Refusing sell orders until position recovers. This requires manual BUY intervention or profile change.`
        );
        return;
      }
      
      // Check available EPWX before placing order
      const balances = await this.exchange.getBalances();
      const epwxBalance = balances.find(b => b.asset === 'EPWX');
      const availableEPWX = epwxBalance?.free || 0;
      const normalizedAmount = this.applyOrderAmountCap(Math.floor(amount), 'SELL', price, availableEPWX * price);
      if (!this.isRunning || !Number.isFinite(price) || !Number.isFinite(normalizedAmount) || normalizedAmount < this.minQty) {
        logger.warn(`⚠️  Skipping sell order before placement: running=${this.isRunning}, amount=${normalizedAmount}, minQty=${this.minQty}, price=${price}`);
        return;
      }

      if (!isWashTrade && config.volumeStrategy.sellNearBidEnabled && this.getForceBuyPause()) {
        const ticker = await this.exchange.getTicker(this.symbol);
        const bid = Number(ticker?.bid ?? 0);
        const ask = Number(ticker?.ask ?? 0);
        const bestBid = Math.min(bid, ask);

        if (Number.isFinite(bestBid) && bestBid > 0) {
          const tick = this.getEffectiveTickSize();
          const anchorTicks = Math.max(Math.floor(config.volumeStrategy.sellNearBidTicks), 0);
          const markupBps = Math.max(config.volumeStrategy.sellNearBidMinMarkupBps, 0);
          const tickAnchoredPrice = bestBid + (tick * anchorTicks);
          const bpsAnchoredPrice = bestBid * (1 + (markupBps / 10000));
          const nearBidSellPrice = Math.max(tickAnchoredPrice, bpsAnchoredPrice, Number.EPSILON);

          if (nearBidSellPrice < price) {
            logger.info(
              `🎯 Sell-near-bid mode: adjusting sell anchor from ${price.toExponential(4)} to ${nearBidSellPrice.toExponential(4)} (bestBid=${bestBid.toExponential(4)})`
            );
            price = nearBidSellPrice;
          }
        }
      }

      // Safety floor: never sell below 99.5% of reference (prevents loss-making sales)
      const floorPrice = referencePrice * 0.995;
      if (price < floorPrice) {
        logger.warn(
          `⚠️  Sell floor protection: rejected price ${price.toExponential(4)} below fair value floor ${floorPrice.toExponential(4)}. Skipping potentially loss-making sale.`
        );
        return;
      }

      const requestedPrice = price;
      const requestedAmount = normalizedAmount;

      const clampedPrice = await this.clampPriceToLatestBand(price, 'SELL');
      if (clampedPrice !== price) {
        logger.warn(
          `⚠️  Clamping sell price from ${price.toExponential(4)} to ${clampedPrice.toExponential(4)} to stay within the latest-price band`
        );
        price = clampedPrice;
      }

      price = await this.offsetSellPriceFromOpenLevels(price);

      if (!isWashTrade && await this.wouldCrossOpenBook('SELL', price)) {
        logger.warn(`🛑 Skipping SELL at ${price.toExponential(4)} because it would cross the open bid book.`);
        return;
      }

      if (this.isExtremeClampReprice(requestedPrice, price)) {
        logger.warn(
          `⚠️  Skipping sell order due to extreme clamp reprice: requested=${requestedPrice.toExponential(4)}, executable=${price.toExponential(4)} (limit x${VolumeGenerationStrategy.MAX_CLAMP_REPRICE_RATIO.toFixed(2)})`
        );
        return;
      }

      const executableAmount = this.recalculateExecutableOrderAmount('SELL', requestedPrice, requestedAmount, price, 0, availableEPWX);
      if (executableAmount === null) {
        logger.warn(
          `⚠️  Skipping sell order after repricing: requested=${requestedAmount.toFixed(2)} @ ${requestedPrice.toExponential(4)}, executable=${price.toExponential(4)}, available=${availableEPWX.toFixed(2)} EPWX`
        );
        return;
      }

      if (executableAmount !== normalizedAmount) {
        logger.warn(
          `⚠️  Reducing sell amount from ${normalizedAmount.toLocaleString()} to ${executableAmount.toLocaleString()} after price clamp to respect the executable notional`
        );
      }

      amount = executableAmount;

      if (amount > availableEPWX) {
        logger.warn(`⚠️  Skipping sell order: requested ${amount.toFixed(2)} EPWX > available ${availableEPWX.toFixed(2)} EPWX`);
        return;
      }
      if (!this.isRunning) {
        logger.warn(`⚠️  Aborting sell order after balance check because the bot is stopping: amount=${amount}, price=${price}`);
        return;
      }
      logger.debug(`Attempting to place sell order: ${amount.toFixed(2)} @ ${price.toExponential(4)}`);
      const order = await this.exchange.placeOrder(
        this.symbol,
        'SELL',
        'LIMIT',
        amount,
        price
      );
      if (!order) {
        logger.error('Sell order placement returned undefined');
        return;
      }
      if (!this.isRunning) {
        logger.warn(`⚠️  Cancelling sell order ${order.orderId} because it was placed during shutdown.`);
        await this.exchange.cancelOrder(this.symbol, order.orderId);
        return;
      }
      this.activeOrders.set(order.orderId, order);
      this.orderPrices.set(order.orderId, { side: 'SELL', price });
      this.volumeStats.orderCount++;
      logger.info(`✅ Sell order placed: ${amount.toLocaleString()} EPWX @ $${price.toExponential(4)}`);
      void this.logPostPlacementOrderState(order.orderId, 'SELL', price);

      // Poll for fills after placing order
      void this.pollOrderFills(order.orderId, 'SELL', isWashTrade);
      return order.orderId;
    } catch (error) {
      logger.error('Error placing sell order:', error);
    }
  }

  // Poll for fills after placing an order
  protected async pollOrderFills(orderId: string, side: 'BUY' | 'SELL', isWashTrade: boolean = false) {
    try {
      // Wait a short time for matching to occur
      await new Promise(resolve => setTimeout(resolve, 1000));
      const trades = await this.exchange.getRecentTrades(this.symbol, 10, orderId);
      if (trades && trades.length > 0) {
        this.recordTrades(trades, orderId, isWashTrade, side);
        this.pnlSettledOrderIds.add(orderId);
        const filledAmount = trades.reduce((sum, trade) => sum + trade.amount, 0);
        const filledVolumeUSD = trades.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
        this.applyPositionForFilledOrder(orderId, side, filledAmount);
        if (isWashTrade) {
          this.settlePairedWashOrder(orderId, side, filledAmount, filledVolumeUSD);
        }
      } else {
        const reconciled = await this.reconcileCompletedOrderWithoutTrades(orderId, side, isWashTrade, 'poll');
        if (reconciled !== 'FILLED') {
          logger.info(`No fills detected for order ${orderId} (${side}) after 1s.`);
          await this.logNoFillDiagnostics(orderId, side);
        }
      }
    } catch (error) {
      logger.error(`Error polling fills for order ${orderId}:`, error);
    }
  }

  private randomizeOrderSize(): number {
    const { minOrderSize, maxOrderSize } = config.volumeStrategy;
    const range = maxOrderSize - minOrderSize;
    return minOrderSize + Math.random() * range;
  }

  private async updateOrderStatus(): Promise<void> {
    const orderIds = Array.from(this.activeOrders.keys());
    const batchSize = 5; // Only check 5 orders per cycle
    if (orderIds.length === 0) return;
    // Rotate through the list
    const start = this.orderStatusIndex;
    const end = Math.min(start + batchSize, orderIds.length);
    const batch = orderIds.slice(start, end);
    this.orderStatusIndex = end >= orderIds.length ? 0 : end;
    let backoff = 1000; // Start with 1s
    for (const orderId of batch) {
      try {
        const order = await this.exchange.getOrder(this.symbol, orderId);

        if (order.status === 'FILLED') {
          // Update volume stats
          const volumeUSD = order.filled * order.price;
          this.volumeStats.totalVolume += volumeUSD;

          if (order.side === 'BUY') {
            this.volumeStats.buyVolume += volumeUSD;
            this.currentPosition += order.filled;
          } else {
            this.volumeStats.sellVolume += volumeUSD;
            this.currentPosition -= order.filled;
          }

          const trackedAsWashPair = this.washTradePairsActive.some(pair => pair.buyOrderId === orderId || pair.sellOrderId === orderId);
          let isRealFill = true;

          if (!config.volumeStrategy.selfTradeEnabled) {
            isRealFill = true;
          } else if (trackedAsWashPair) {
            isRealFill = false;
          } else {
            isRealFill = true;
          }

          if (order.filled > 0 && !this.pnlSettledOrderIds.has(orderId)) {
            const realizedPnl = this.applyEconomicFill(order.side, order.filled, order.price, !isRealFill);
            this.pnlSettledOrderIds.add(orderId);
            if (isRealFill) {
              this.noteRealFillDetected(`order status FILLED ${orderId}`);
              logger.info(`💰 REAL FILL: ${order.side} ${order.filled.toFixed(0)} @ $${order.price.toExponential(4)} | RealizedPnL: $${realizedPnl.toFixed(4)} | TotalPnL: $${this.profitStats.totalPnl.toFixed(4)}`);
            }
          } else if (!isRealFill) {
            this.profitStats.washTrades++;
            logger.info(`🔄 WASH TRADE FILLED: ${order.side} ${order.filled.toFixed(0)} @ $${order.price.toExponential(4)}`);
          } else {
            logger.info(`💰 REAL FILL already accounted: ${order.side} ${order.filled.toFixed(0)} @ $${order.price.toExponential(4)}`);
          }

          logger.info(`✅ Order filled: ${order.side} ${order.filled} @ $${order.price.toFixed(6)} | Volume: $${volumeUSD.toFixed(2)}`);
          
          this.activeOrders.delete(orderId);
          this.orderPrices.delete(orderId);
        } else if (order.status === 'CANCELED') {
          this.activeOrders.delete(orderId);
          this.orderPrices.delete(orderId);
        }
      } catch (error: any) {
        if (error.message && error.message.includes('Service is not available')) {
          logger.warn(`Exchange service temporarily unavailable while checking order ${orderId}. Retrying on next cycle.`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, 15000); // Exponential backoff up to 15s
          continue;
        }
        if (error.response && error.response.status === 429) {
          logger.warn('Rate limit hit (429). Backing off...');
          await new Promise(resolve => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, 15000); // Exponential backoff up to 15s
          continue;
        }
        if (error.message && error.message.includes('Order not found or already completed')) {
          const capturedAnyTrade = await this.captureTradesForCompletedOrder(orderId);
          if (!capturedAnyTrade) {
            await this.logOrderDisappearance(orderId);
          }
          logger.info(`Order ${orderId} not found or already completed. Removing from activeOrders.`);
          this.activeOrders.delete(orderId);
          this.orderPrices.delete(orderId);
          continue;
        }
        logger.error('Error updating order status:', error);
      }
      // Add a delay between each order status check to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  private recordTrades(trades: Trade[], orderId: string, isWashTrade: boolean, orderSide?: 'BUY' | 'SELL'): void {
    const trackedOrderSide = orderSide
      ?? this.activeOrders.get(orderId)?.side
      ?? (this.orderPrices.get(orderId)?.side as 'BUY' | 'SELL' | undefined);

    for (const trade of trades) {
      if (this.processedTradeIds.has(trade.tradeId)) {
        continue;
      }

      this.processedTradeIds.add(trade.tradeId);
      const effectiveSide = trackedOrderSide ?? trade.side;

      if (trackedOrderSide && trade.side !== trackedOrderSide) {
        logger.debug(`Trade ${trade.tradeId} side ${trade.side} differs from tracked order ${orderId} side ${trackedOrderSide}; using tracked order side for accounting.`);
      }

      logger.info(`🎯 Trade fill detected: ${effectiveSide} ${trade.amount} @ $${trade.price} (Order ID: ${orderId}, Trade ID: ${trade.tradeId})`);

      const volumeUSD = trade.amount * trade.price;
      this.volumeStats.totalVolume += volumeUSD;
      if (effectiveSide === 'BUY') {
        this.volumeStats.buyVolume += volumeUSD;
      }
      if (effectiveSide === 'SELL') {
        this.volumeStats.sellVolume += volumeUSD;
      }

      if (isWashTrade) {
        this.profitStats.washTrades++;
        logger.info(`🔄 WASH TRADE FILL: ${effectiveSide} ${trade.amount} @ $${trade.price} (Order ID: ${orderId}, Trade ID: ${trade.tradeId})`);
      } else {
        this.noteRealFillDetected(`trade ${trade.tradeId}`);
        const realizedPnl = this.applyEconomicFill(effectiveSide, trade.amount, trade.price, false);
        logger.info(
          `💰 REAL TRADE PNL: ${effectiveSide} ${trade.amount} @ $${trade.price} (Order ID: ${orderId}, Trade ID: ${trade.tradeId}) | RealizedPnL: $${realizedPnl.toFixed(4)} | UnrealizedPnL: $${this.profitStats.unrealizedPnl.toFixed(4)}`
        );
      }
    }
  }

  private applyPositionForFilledOrder(orderId: string, side: 'BUY' | 'SELL', filledAmount: number): void {
    if (this.positionAdjustedOrderIds.has(orderId) || filledAmount <= 0) {
      return;
    }

    if (side === 'BUY') {
      this.currentPosition += filledAmount;
    } else {
      this.currentPosition -= filledAmount;
    }

    this.positionAdjustedOrderIds.add(orderId);
  }

  private async syncCurrentPositionWithBalances(): Promise<void> {
    const balances = await this.exchange.getBalances();
    const epwxBalance = balances.find(balance => balance.asset === 'EPWX');
    const usdtBalance = balances.find(balance => balance.asset === 'USDT');
    const totalEpwx = epwxBalance?.total ?? ((epwxBalance?.free || 0) + (epwxBalance?.locked || 0));
    const totalUsdt = usdtBalance?.total ?? ((usdtBalance?.free || 0) + (usdtBalance?.locked || 0));

    if (!Number.isFinite(totalEpwx)) {
      return;
    }

    this.latestEpwxTotal = totalEpwx;
    this.latestUsdtTotal = Number.isFinite(totalUsdt) ? totalUsdt : this.latestUsdtTotal;

    if (this.lifetimeBaselineEpwx === null) {
      this.lifetimeBaselineEpwx = totalEpwx;
    }

    if (this.lifetimeBaselineUsdt === null && Number.isFinite(totalUsdt)) {
      this.lifetimeBaselineUsdt = totalUsdt;
    }

    if (this.initialEpwxBalance === null) {
      this.initialEpwxBalance = totalEpwx;
      this.currentPosition = 0;
      logger.info(`📌 Position baseline initialized from EPWX balance: ${this.initialEpwxBalance.toFixed(0)}`);
      this.persistRuntimeState(true);
      return;
    }

    this.currentPosition = totalEpwx - this.initialEpwxBalance;
    this.persistRuntimeState();
  }

  private settlePairedWashOrder(orderId: string, side: 'BUY' | 'SELL', filledAmount: number, filledVolumeUSD: number): void {
    const pair = this.washTradePairsActive.find(candidate =>
      candidate.buyOrderId === orderId || candidate.sellOrderId === orderId
    );

    if (!pair) {
      return;
    }

    const counterpartOrderId = pair.buyOrderId === orderId ? pair.sellOrderId : pair.buyOrderId;
    const counterpartSide: 'BUY' | 'SELL' = side === 'BUY' ? 'SELL' : 'BUY';

    if (this.settledWashOrderIds.has(counterpartOrderId)) {
      return;
    }

    this.volumeStats.totalVolume += filledVolumeUSD;
    if (counterpartSide === 'BUY') {
      this.volumeStats.buyVolume += filledVolumeUSD;
    } else {
      this.volumeStats.sellVolume += filledVolumeUSD;
    }

    this.applyPositionForFilledOrder(counterpartOrderId, counterpartSide, filledAmount);
    this.settledWashOrderIds.add(orderId);
    this.settledWashOrderIds.add(counterpartOrderId);
    this.activeOrders.delete(counterpartOrderId);
    this.orderPrices.delete(counterpartOrderId);
    this.washTradePairsActive = this.washTradePairsActive.filter(candidate => candidate !== pair);

    logger.info(`🔁 Settled paired wash ${counterpartSide} leg for ${counterpartOrderId} after ${side} fill on ${orderId}.`);
  }

  private async captureTradesForCompletedOrder(orderId: string): Promise<boolean> {
    try {
      const trades = await this.exchange.getRecentTrades(this.symbol, 20, orderId);
      const trackedOrder = this.activeOrders.get(orderId);
      const isWashTrade = this.washTradePairsActive.some(pair => pair.buyOrderId === orderId || pair.sellOrderId === orderId);
      const trackedOrderSide = trackedOrder?.side ?? (this.orderPrices.get(orderId)?.side as 'BUY' | 'SELL' | undefined);

      if (!trades.length) {
        if (!trackedOrderSide) {
          return false;
        }
        const resolution = await this.reconcileCompletedOrderWithoutTrades(orderId, trackedOrderSide, isWashTrade, 'completed');
        if (resolution === 'NO_FILL') {
          logger.info(`📭 [ORDER-NO-FILL] ${orderId} completed without executed quantity.`);
        } else if (resolution === 'UNRESOLVED') {
          logger.warn(`❓ [ORDER-UNRESOLVED] ${orderId} could not be classified from exchange history.`);
        }
        return resolution === 'FILLED';
      }

      this.recordTrades(trades, orderId, isWashTrade, trackedOrderSide);

      if (trackedOrderSide) {
        const filledAmount = trades.reduce((sum, trade) => sum + trade.amount, 0);
        const filledVolumeUSD = trades.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
        this.applyPositionForFilledOrder(orderId, trackedOrderSide, filledAmount);
        if (isWashTrade) {
          this.settlePairedWashOrder(orderId, trackedOrderSide, filledAmount, filledVolumeUSD);
        }
      }

      this.pnlSettledOrderIds.add(orderId);

      return true;
    } catch (error) {
      logger.warn(`Could not fetch trades for completed order ${orderId}:`, error);
      return false;
    }
  }

  private async reconcileCompletedOrderWithoutTrades(
    orderId: string,
    side: 'BUY' | 'SELL',
    isWashTrade: boolean,
    source: 'poll' | 'completed'
  ): Promise<CompletedOrderResolution> {
    if (this.pnlSettledOrderIds.has(orderId)) {
      return 'FILLED';
    }

    if (this.reconcilingCompletedOrderIds.has(orderId)) {
      return 'UNRESOLVED';
    }

    this.reconcilingCompletedOrderIds.add(orderId);

    try {
      const finishedOrder = await this.exchange.getFinishedOrder(this.symbol, orderId);
      if (!finishedOrder) {
        return 'UNRESOLVED';
      }
      if (finishedOrder.filled <= 0) {
        return 'NO_FILL';
      }

      const fallbackPrice = this.orderPrices.get(orderId)?.price ?? 0;
      const fillPrice = Number.isFinite(finishedOrder.price) && finishedOrder.price > 0
        ? finishedOrder.price
        : fallbackPrice;

      if (!Number.isFinite(fillPrice) || fillPrice <= 0) {
        return 'UNRESOLVED';
      }

      const filledAmount = finishedOrder.filled;
      const filledVolumeUSD = filledAmount * fillPrice;

      this.volumeStats.totalVolume += filledVolumeUSD;
      if (side === 'BUY') {
        this.volumeStats.buyVolume += filledVolumeUSD;
      } else {
        this.volumeStats.sellVolume += filledVolumeUSD;
      }

      this.applyPositionForFilledOrder(orderId, side, filledAmount);

      if (isWashTrade) {
        this.profitStats.washTrades++;
        this.settlePairedWashOrder(orderId, side, filledAmount, filledVolumeUSD);
        logger.info(
          `🔄 WASH TRADE FILL (${source}-fallback): ${side} ${filledAmount.toFixed(0)} @ $${fillPrice.toExponential(4)} (Order ID: ${orderId})`
        );
      } else {
        this.noteRealFillDetected(`finished-order ${source} fallback ${orderId}`);
        const realizedPnl = this.applyEconomicFill(side, filledAmount, fillPrice, false);
        logger.info(
          `💰 REAL FILL (${source}-fallback): ${side} ${filledAmount.toFixed(0)} @ $${fillPrice.toExponential(4)} (Order ID: ${orderId}) | RealizedPnL: $${realizedPnl.toFixed(4)} | TotalPnL: $${this.profitStats.totalPnl.toFixed(4)}`
        );
      }

      this.pnlSettledOrderIds.add(orderId);
      return 'FILLED';
    } finally {
      this.reconcilingCompletedOrderIds.delete(orderId);
    }
  }

  private getSanitizedTickerQuotes(
    ticker: { bid: number; ask: number }
  ): { bestBid: number; bestAsk: number; midPrice: number; spreadPercent: number } | null {
    if (!Number.isFinite(ticker.bid) || !Number.isFinite(ticker.ask)) {
      return null;
    }

    const bestBid = Math.min(ticker.bid, ticker.ask);
    const bestAsk = Math.max(ticker.bid, ticker.ask);

    if (bestBid <= 0 || bestAsk <= 0) {
      return null;
    }

    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPercent = ((bestAsk - bestBid) / bestBid) * 100;

    return { bestBid, bestAsk, midPrice, spreadPercent };
  }

  private async checkAndRebalancePosition(): Promise<void> {
    if (!config.risk.enablePositionLimits) return;

    const positionThreshold = config.marketMaking.positionRebalanceThreshold;
    const rebalanceCooldownMs = Math.max(config.marketMaking.rebalanceCooldownMs, config.marketMaking.updateInterval);
    const rebalanceMaxSpreadPercent = Math.max(config.marketMaking.rebalanceMaxSpreadPercent, 0);
    const rebalanceMaxPriceDeviationPercent = Math.max(config.marketMaking.rebalanceMaxPriceDeviationPercent, 0);

    if (Math.abs(this.currentPosition) > positionThreshold) {
      if (this.rebalanceInProgress) {
        logger.info('⏭️  Rebalance already in progress; skipping this monitoring tick.');
        return;
      }

      const now = Date.now();
      const elapsedSinceLastRebalance = now - this.lastRebalanceAt;
      if (this.lastRebalanceAt > 0 && elapsedSinceLastRebalance < rebalanceCooldownMs) {
        logger.info(
          `⏭️  Rebalance cooldown active (${Math.ceil((rebalanceCooldownMs - elapsedSinceLastRebalance) / 1000)}s remaining); skipping this monitoring tick.`
        );
        return;
      }

      logger.warn(`⚖️ Position rebalance needed: ${this.currentPosition.toFixed(2)}`);

      this.rebalanceInProgress = true;
      this.lastRebalanceAt = now;

      try {
        const ticker = await this.exchange.getTicker(this.symbol);
        const sanitizedQuotes = this.getSanitizedTickerQuotes(ticker);

        if (!sanitizedQuotes) {
          logger.warn('⚠️  Skipping rebalance because ticker quotes are invalid.');
          return;
        }

        if (sanitizedQuotes.spreadPercent > rebalanceMaxSpreadPercent) {
          logger.warn(
            `⚠️  Skipping rebalance because ticker spread is too wide (${sanitizedQuotes.spreadPercent.toFixed(2)}% > ${rebalanceMaxSpreadPercent.toFixed(2)}%).`
          );
          return;
        }

        const targetResidualPosition = positionThreshold * 0.6;
        const excessPosition = Math.max(Math.abs(this.currentPosition) - targetResidualPosition, 0);
        const rebalanceAmountRaw = Math.min(Math.abs(this.currentPosition) * 0.25, excessPosition);
        const rebalanceAmount = this.normalizeOrderAmount(rebalanceAmountRaw);

        if (rebalanceAmount === null) {
          logger.warn(`⚠️  Skipping rebalance because normalized amount is below minQty (${this.minQty})`);
          return;
        }

        const rebalanceSide: 'BUY' | 'SELL' = this.currentPosition > 0 ? 'SELL' : 'BUY';
        const rebalancePrice = rebalanceSide === 'SELL' ? sanitizedQuotes.bestAsk : sanitizedQuotes.bestBid;

        if (rebalanceSide === 'BUY' && this.getForceBuyPause()) {
          logger.warn('🧯 Skipping rebalance BUY because FORCE_BUY_PAUSE=true.');
          return;
        }

        const markReference = this.profitStats.inventoryMarkPrice > 0
          ? this.profitStats.inventoryMarkPrice
          : sanitizedQuotes.midPrice;
        const quoteDeviationPercent =
          markReference > 0
            ? (Math.abs(rebalancePrice - markReference) / markReference) * 100
            : 0;

        if (quoteDeviationPercent > rebalanceMaxPriceDeviationPercent) {
          logger.warn(
            `⚠️  Skipping rebalance ${rebalanceSide} because quote deviation is too high (${quoteDeviationPercent.toFixed(2)}% > ${rebalanceMaxPriceDeviationPercent.toFixed(2)}%; quote=${rebalancePrice.toExponential(4)}, reference=${markReference.toExponential(4)}).`
          );
          return;
        }

        // Cancel existing orders only after safety guards pass.
        await this.exchange.cancelAllOrders(this.symbol);
        this.activeOrders.clear();

        if (rebalanceSide === 'SELL') {
          // We have too much, sell
          await this.placeSellOrder(rebalancePrice, rebalanceAmount);
          logger.info(`📉 Rebalancing: Selling ${rebalanceAmount.toFixed(2)}`);
        } else {
          // We're short, buy
          await this.placeBuyOrder(rebalancePrice, rebalanceAmount);
          logger.info(`📈 Rebalancing: Buying ${rebalanceAmount.toFixed(2)}`);
        }
      } catch (error) {
        logger.error('Error rebalancing position:', error);
      } finally {
        this.rebalanceInProgress = false;
      }
    }
  }

  private logPerformance(): void {
    const now = Date.now();
    if (now - this.lastPerformanceLogAt < 60000) {
      return;
    }
    this.lastPerformanceLogAt = now;

    const runTimeHours = (Date.now() - this.volumeStats.startTime) / (1000 * 60 * 60);
    const volumeRate = this.volumeStats.totalVolume / runTimeHours;
    const projectedDaily = volumeRate * 24;
    const targetProgress = (projectedDaily / config.volumeStrategy.volumeTargetDaily) * 100;

    logger.info('📊 Volume Statistics:');
    logger.info(`  Total Volume: $${this.volumeStats.totalVolume.toFixed(2)}`);
    logger.info(`  Buy Volume: $${this.volumeStats.buyVolume.toFixed(2)}`);
    logger.info(`  Sell Volume: $${this.volumeStats.sellVolume.toFixed(2)}`);
    logger.info(`  Orders: ${this.volumeStats.orderCount}`);
    logger.info(`  Active Orders: ${this.activeOrders.size}`);
    logger.info(`  Current Position: ${this.currentPosition.toFixed(2)}`);
    logger.info(`  Projected 24h: $${projectedDaily.toFixed(2)} (${targetProgress.toFixed(1)}% of target)`);
    logger.info(`  Runtime: ${runTimeHours.toFixed(2)} hours`);

    // Log profit statistics
    logger.info('💎 Profit Statistics:');
    logger.info(`  Real Fills: ${this.profitStats.realFills}`);
    logger.info(`  Wash Trades: ${this.profitStats.washTrades}`);
    logger.info(`  Realized PnL: $${this.profitStats.realizedPnl.toFixed(4)}`);
    logger.info(`  Unrealized PnL: $${this.profitStats.unrealizedPnl.toFixed(4)}`);
    logger.info(`  Total PnL: $${this.profitStats.totalPnl.toFixed(4)}`);
    logger.info(`  Real Fill Realized PnL: $${this.profitStats.realFillRealizedPnl.toFixed(4)}`);
    logger.info(`  Avg Realized PnL / Real Fill: $${this.profitStats.averageRealizedPnlPerRealFill.toFixed(4)}`);
    logger.info(`  Best Realized Fill: $${this.profitStats.bestRealizedFillPnl.toFixed(4)}`);
    logger.info(`  Inventory Qty: ${this.profitStats.inventoryQuantity.toFixed(4)} EPWX @ mark $${this.profitStats.inventoryMarkPrice.toFixed(6)}`);
    logger.info(`  Inventory Cost Basis: $${this.profitStats.inventoryCostBasisUsd.toFixed(4)}`);
    logger.info(`  Projected 24h Realized PnL: $${this.profitStats.estimatedDailyRealizedPnl.toFixed(2)}`);

    if (
      this.lifetimeBaselineEpwx !== null &&
      this.lifetimeBaselineUsdt !== null &&
      this.latestEpwxTotal !== null &&
      this.latestUsdtTotal !== null
    ) {
      const deltaEpwx = this.latestEpwxTotal - this.lifetimeBaselineEpwx;
      const deltaUsdt = this.latestUsdtTotal - this.lifetimeBaselineUsdt;
      const markPrice = this.profitStats.inventoryMarkPrice;

      if (markPrice > 0) {
        const deltaUsdEstimate = deltaUsdt + (deltaEpwx * markPrice);
        logger.info(
          `  Balance Delta (persistent baseline): EPWX ${deltaEpwx.toFixed(0)}, USDT ${deltaUsdt.toFixed(4)}, estUSD ${deltaUsdEstimate.toFixed(4)} @ mark ${markPrice.toExponential(4)}`
        );
      } else {
        logger.info(
          `  Balance Delta (persistent baseline): EPWX ${deltaEpwx.toFixed(0)}, USDT ${deltaUsdt.toFixed(4)} (mark unavailable)`
        );
      }
    }

    this.persistRuntimeState();
  }

  private async logBalances(): Promise<void> {
    try {
      const balances = await this.exchange.getBalances();
      logger.info('💰 Account Balances:');
      balances
        .filter(b => b.total > 0)
        .forEach(b => {
          logger.info(`  ${b.asset}: ${b.total.toFixed(8)} (Free: ${b.free.toFixed(8)}, Locked: ${b.locked.toFixed(8)})`);
        });
    } catch (error) {
      logger.error('Error fetching balances:', error);
    }
  }

  private async logFinalStats(): Promise<void> {
    const runTimeHours = (Date.now() - this.volumeStats.startTime) / (1000 * 60 * 60);

    logger.info('');
    logger.info('═══════════════════════════════════════');
    logger.info('📈 FINAL VOLUME GENERATION REPORT');
    logger.info('═══════════════════════════════════════');
    logger.info(`Total Volume Generated: $${this.volumeStats.totalVolume.toFixed(2)}`);
    logger.info(`Buy Volume: $${this.volumeStats.buyVolume.toFixed(2)}`);
    logger.info(`Sell Volume: $${this.volumeStats.sellVolume.toFixed(2)}`);
    logger.info(`Total Orders: ${this.volumeStats.orderCount}`);
    logger.info(`Runtime: ${runTimeHours.toFixed(2)} hours`);
    logger.info(`Average Volume/Hour: $${(this.volumeStats.totalVolume / runTimeHours).toFixed(2)}`);
    logger.info('═══════════════════════════════════════');
    logger.info('');

    await this.logBalances();
  }
}
