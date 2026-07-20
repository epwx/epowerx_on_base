import { BiconomyExchangeService, Order, Trade } from '../services/biconomy-exchange.service';
import { getEPWXPairInfo } from '../utils/exchange-info';
import { logger } from '../utils/logger';
import { config } from '../config';
import { fetchEpwXPriceFromPancake, fetchEpwXPriceInWethOnly } from '../utils/dex-price';
import { quantizeToStepSize } from '../utils/quantize';
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
    cost?: number; // Total cost for profit % calculation
  realFills: number; // Count of orders filled by real users
  washTrades: number; // Count of self-executed wash trades
  totalProfit: number; // Total profit from spread captures
  profitFromRealFills: number; // Profit specifically from real user fills
  averageSpreadCaptured: number; // Average spread % captured
  bestProfit: number; // Highest single fill profit
  estimatedDailyProfit: number; // Projected 24h profit
}

/**
 * Volume Generation Strategy
 * Generates trading volume on Biconomy Exchange using zero-fee MM account
 */
export class VolumeGenerationStrategy {
  private static readonly MIN_ORDER_NOTIONAL_USD = 5.01;
  private static readonly SELL_IMBALANCE_GUARD_MIN_GAP = 3;
  private static readonly SELL_IMBALANCE_GUARD_MIN_RATIO = 1.8;
  private static readonly MAX_EXECUTABLE_SPREAD_PERCENT = 5;
  private static readonly QUOTE_CHURN_REFRESH_PER_SIDE = 2;
    public getProfitStats(): ProfitStats {
      return this.profitStats;
    }
  // Track active wash trade pairs for fill detection
  protected washTradePairsActive: Array<{ buyOrderId: string, sellOrderId: string, price: number, amount: number }> = [];
  static readonly DEX_PROVIDER_URL = 'https://mainnet.base.org';
  static readonly DEX_PAIR_ADDRESS = '0x8c4fe7dd7f57c8da00ec0766a4767dacdab47bc8';
  static readonly EPWX_ADDRESS = '0xef5f5751cf3eca6cc3572768298b7783d33d60eb';
  protected exchange: BiconomyExchangeService;
  private isRunning: boolean = false;
  private stepSize: number = 1;
  private minQty: number = 1;
  private symbol: string;
  private volumeStats: VolumeStats;
  protected profitStats: ProfitStats;
  private activeOrders: Map<string, Order> = new Map();
  private orderPrices: Map<string, { side: string; price: number }> = new Map(); // Track original order prices for profit calculation
  private processedTradeIds: Set<string> = new Set();
  private positionAdjustedOrderIds: Set<string> = new Set();
  private settledWashOrderIds: Set<string> = new Set();
  private updateTimer?: NodeJS.Timeout;
  private orderTimer?: NodeJS.Timeout;
  private priceTrackingTimer?: NodeJS.Timeout;
  private initialEpwxBalance: number | null = null;
  private currentPosition: number = 0;
  private orderStatusIndex: number = 0;
  private isPlacingOrders: boolean = false;
  private lastPerformanceLogAt: number = 0;
  private noFillDiagnosticsThisCycle: number = 0;
  private lastDexPrice: number | null = null;
  private lastOrderRefreshTime: number = 0;
  private static readonly DEX_PRICE_DRIFT_THRESHOLD_PERCENT = 1.5; // Refresh orders if DEX price moves >1.5%
  private static readonly MIN_REFRESH_INTERVAL_MS = 2000; // Don't refresh more than once per 2 seconds

  constructor(exchange?: BiconomyExchangeService) {
    this.exchange = exchange || new BiconomyExchangeService();
    this.symbol = config.trading.pair;
    this.volumeStats = this.initializeStats();
    this.profitStats = this.initializeProfitStats();
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
      totalProfit: 0,
      profitFromRealFills: 0,
      averageSpreadCaptured: 0,
      bestProfit: 0,
      estimatedDailyProfit: 0,
    };
  }

  private getBalanceUtilizationPercent(): number {
    return Math.min(Math.max(config.volumeStrategy.balanceUtilizationPercent, 0), 1);
  }

  private getIdleBalanceReserveUsd(): number {
    return Math.max(config.volumeStrategy.idleBalanceReserveUsd, 0);
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
    const cap = Math.max(
      Number.isFinite(configuredCap) && configuredCap >= this.minQty ? configuredCap : this.minQty,
      this.getAdaptiveOrderAmountCap(price, availableUsd)
    );

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
  ): Promise<{ bestBid: number; bestAsk: number; midPrice: number } | null> {
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
      return { bestBid, bestAsk, midPrice };
    } catch (error) {
      logger.warn('⚠️  Failed to fetch executable order book snapshot for diagnostics:', error);
      return null;
    }
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
      if (pairInfo.minQty) this.minQty = Number(pairInfo.minQty);
      logger.info(`[PAIR INFO] stepSize=${this.stepSize}, minQty=${this.minQty}, baseAssetPrecision=${pairInfo.baseAssetPrecision}, quoteAssetPrecision=${pairInfo.quoteAssetPrecision}, tickSize=${pairInfo.tickSize}`);
    } catch (e) {
      logger.warn('Could not fetch EPWX/USDT pair info, using defaults.');
    }
    this.isRunning = true;

    try {
      // Cancel any existing orders (ignore errors if endpoint not available)
      try {
        logger.info('Attempting to cancel existing orders...');
        const cancelled = await this.exchange.cancelAllOrders(this.symbol);
        logger.info(`✅ Cancelled ${cancelled} existing orders`);
      } catch (error: any) {
        logger.warn('⚠️  Could not cancel existing orders (endpoint may not be available):', error.message);
      }

      // Get initial balances
      await this.logBalances();
      await this.syncCurrentPositionWithBalances();

      // Start order placement loop
      this.startOrderPlacementLoop();

      // Start monitoring loop
      this.startMonitoringLoop();

      // Start real-time DEX price tracking
      this.startPriceTrackingLoop();

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

    if (this.priceTrackingTimer) {
      clearInterval(this.priceTrackingTimer);
      this.priceTrackingTimer = undefined;
    }

    try {
      await this.exchange.cancelAllOrders(this.symbol);
      this.activeOrders.clear();
      
      await this.logFinalStats();
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

  private startPriceTrackingLoop(): void {
    logger.info('📊 Starting real-time DEX price tracking loop (500ms interval, WETH only - no CoinGecko)...');
    const PRICE_TRACK_INTERVAL_MS = 500; // Check DEX price every 500ms

    this.priceTrackingTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        // Fetch current DEX price in WETH only (no USD conversion to avoid CoinGecko API calls)
        let currentDexPriceInWeth: number | undefined;
        try {
          currentDexPriceInWeth = await fetchEpwXPriceInWethOnly(
            config.trading.baseRpcUrl,
            config.trading.epwxWethPairAddress,
            config.trading.epwxAddress
          );
        } catch (error) {
          logger.warn('⚠️  Failed to fetch DEX price in price tracking loop:', error);
          return;
        }
        
        // Convert WETH to USD for comparison (use last known cached ETH price)
        const currentDexPrice = currentDexPriceInWeth * 2200; // Use fallback value for relative drift calculation

        if (!currentDexPrice || currentDexPrice <= 0 || currentDexPriceInWeth <= 0) {
          logger.warn('⚠️  Invalid DEX price received in tracking loop');
          return;
        }

        // Initialize lastDexPrice on first fetch
        if (this.lastDexPrice === null) {
          this.lastDexPrice = currentDexPrice;
          logger.info(`📊 [PRICE-TRACK] Initial DEX price set: ${currentDexPriceInWeth.toFixed(8)} WETH (≈$${currentDexPrice.toFixed(6)})`);
          return;
        }

        // Calculate drift percentage
        const priceDriftPercent = Math.abs(currentDexPrice - this.lastDexPrice) / this.lastDexPrice * 100;

        // Log price changes (only significant ones to avoid spam)
        if (priceDriftPercent >= 0.3) {
          logger.info(`📊 [PRICE-TRACK] DEX price: $${currentDexPrice.toFixed(6)} (drift: ${priceDriftPercent.toFixed(2)}%)`);
        }

        // If drift exceeds threshold and enough time has passed since last refresh, trigger order refresh
        if (priceDriftPercent >= VolumeGenerationStrategy.DEX_PRICE_DRIFT_THRESHOLD_PERCENT) {
          const timeSinceLastRefresh = Date.now() - this.lastOrderRefreshTime;
          if (timeSinceLastRefresh >= VolumeGenerationStrategy.MIN_REFRESH_INTERVAL_MS) {
            logger.warn(
              `🔄 [PRICE-DRIFT] DEX price drifted ${priceDriftPercent.toFixed(2)}% (threshold: ${VolumeGenerationStrategy.DEX_PRICE_DRIFT_THRESHOLD_PERCENT}%) - triggering order refresh`
            );
            this.lastDexPrice = currentDexPrice;
            this.lastOrderRefreshTime = Date.now();
            await this.refreshOrdersOnPriceDrift(currentDexPrice);
          } else {
            logger.debug(`⏱️  [PRICE-DRIFT] Detected drift but refresh cooldown active (${timeSinceLastRefresh}ms / ${VolumeGenerationStrategy.MIN_REFRESH_INTERVAL_MS}ms)`);
          }
        } else {
          // Update tracking price if drift is minor but positive
          if (priceDriftPercent >= 0.1) {
            this.lastDexPrice = currentDexPrice;
          }
        }
      } catch (error) {
        logger.error('❌ Error in price tracking loop:', error);
      }
    }, PRICE_TRACK_INTERVAL_MS);
  }

  private async refreshOrdersOnPriceDrift(newDexPrice: number): Promise<void> {
    // Skip if already placing orders to avoid conflicts
    if (this.isPlacingOrders) {
      logger.info('⏭️  Price drift refresh deferred - order placement cycle already running');
      return;
    }

    try {
      logger.info('🔄 [DRIFT-REFRESH] Starting order refresh due to price drift...');

      // Cancel excess orders to make room for new ones aligned with current DEX price
      const openOrders = await this.exchange.getOpenOrders(this.symbol);
      const buyOrders = openOrders.filter(o => o.side === 'BUY');
      const sellOrders = openOrders.filter(o => o.side === 'SELL');
      const targetOrdersPerSide = 30;

      // Only cancel a subset to allow gradual refresh rather than full flush
      const refreshPercentage = 0.3; // Refresh 30% of orders
      const buysToCancel = Math.ceil(buyOrders.length * refreshPercentage);
      const sellsToCancel = Math.ceil(sellOrders.length * refreshPercentage);

      if (buysToCancel > 0) {
        const oldestBuys = buyOrders
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, buysToCancel);
        for (const order of oldestBuys) {
          try {
            await this.exchange.cancelOrder(this.symbol, order.orderId);
            logger.debug(`[DRIFT-REFRESH] Cancelled old BUY order: ${order.orderId}`);
          } catch (error) {
            logger.warn(`Failed to cancel BUY order ${order.orderId}:`, error);
          }
        }
      }

      if (sellsToCancel > 0) {
        const oldestSells = sellOrders
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, sellsToCancel);
        for (const order of oldestSells) {
          try {
            await this.exchange.cancelOrder(this.symbol, order.orderId);
            logger.debug(`[DRIFT-REFRESH] Cancelled old SELL order: ${order.orderId}`);
          } catch (error) {
            logger.warn(`Failed to cancel SELL order ${order.orderId}:`, error);
          }
        }
      }

      logger.info(`✅ [DRIFT-REFRESH] Cancelled ${buysToCancel} BUY and ${sellsToCancel} SELL orders to refresh at new price`);
    } catch (error) {
      logger.error('❌ Error refreshing orders on price drift:', error);
    }
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

      // Fetch DEX price from PancakeSwap (EPWX/WETH + CoinGecko ETH/USD)
      logger.info('🔄 [DEX] Fetching EPWX price from PancakeSwap...');
      let dexPriceUSD: number | undefined;
      try {
        dexPriceUSD = await fetchEpwXPriceFromPancake(
          config.trading.baseRpcUrl,
          config.trading.epwxWethPairAddress,
          config.trading.epwxAddress
        );
        logger.info(`🥞 DEX (PancakeSwap) price fetched: 1 EPWX ≈ ${dexPriceUSD} USD`);
        // Apply markup for CEX mirroring
        // Use 6% less than DEX price for reference
        const discountPercent = 6;
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
      if (!lastPrice || lastPrice === 0) {
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
      const executableSpreadPercent =
        executableBestBid > 0 && executableBestAsk > 0
          ? ((executableBestAsk - executableBestBid) / executableBestBid) * 100
          : Infinity;
      const executableMidUsable =
        executableMidPrice > 0 &&
        Number.isFinite(executableSpreadPercent) &&
        executableSpreadPercent <= VolumeGenerationStrategy.MAX_EXECUTABLE_SPREAD_PERCENT;

      // Compare DEX and Biconomy price
      // Keep DEX as wash reference, but use executable book mid for placements when available.
      const washPriceReference = lastPrice;
      const priceReference = executableMidUsable ? executableMidPrice : lastPrice;

      if (executableMidUsable) {
        logger.info(`🎯 Using executable orderbook mid-price for placements: ${executableMidPrice.toExponential(4)} (wash reference remains DEX ${washPriceReference.toExponential(4)})`);
      } else if (executableMidPrice > 0) {
        logger.warn(
          `⚠️  Executable orderbook spread too wide (${executableSpreadPercent.toFixed(2)}%), using DEX price for placements: ${washPriceReference.toExponential(4)}`
        );
      } else {
        logger.warn(`⚠️  Executable orderbook mid unavailable, using DEX price for placements: ${washPriceReference.toExponential(4)}`);
      }

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

      // Place and maintain at least 30 buy and 30 sell orders in the order book
      const targetOrdersPerSide = 30;
      const maxPlacementsPerCycle = Math.max(
        8,
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
        const refreshPerSide = Math.min(
          VolumeGenerationStrategy.QUOTE_CHURN_REFRESH_PER_SIDE,
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

      // --- Order Depth Logic ---
      // Place new orders using side-specific balance-aware sizing
      const balances = await this.exchange.getBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      const epwxBalance = balances.find(b => b.asset === 'EPWX');
      const availableUSDT = usdtBalance?.free || 0;
      const availableEPWX = epwxBalance?.free || 0;
      const availableSellUsd = availableEPWX * priceReference;
      const buySafeOrderSizeUSD = this.getBalanceAwareOrderUsdTarget(availableUSDT, targetOrdersPerSide, this.getBalanceUtilizationPercent());
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
      logger.info(
        `🧮 Placement budgets: max=${maxPlacementsPerCycle}, book=${bookPlacementBudget}, reservedWash=${washReservedPlacements}, targetWashPairs=${dynamicWashTradePairs}`
      );

      // Place one small top-touch order per side to improve fill discovery while keeping most quotes passive.
      if (hasExecutableTouchLevels) {
        const topTouchBaseUsd = Math.max(
          this.getMinimumOrderUsdTarget(),
          Math.min(
            Math.min(buySafeOrderSizeUSD, sellSafeOrderSizeUSD),
            this.getEffectiveOrderUsdCap(Math.min(availableUSDT, availableSellUsd))
          )
        );

        if (hasBuyPlacementBudget()) {
          const buyTouchPrice = executableBestAsk;
          const buyTouchUsd = this.getDynamicOrderUsdTarget(topTouchBaseUsd);
          const buyTouchRawAmount = buyTouchUsd / buyTouchPrice;
          const buyTouchAmount = this.normalizeOrderAmount(quantizeToStepSize(buyTouchRawAmount, this.stepSize), buyTouchPrice, availableUSDT);
          if (buyTouchAmount !== null && this.isValidOrderAmount(buyTouchAmount, buyTouchPrice)) {
            logger.info(`🎯 Placing top-touch BUY: ${buyTouchAmount} EPWX @ ${buyTouchPrice.toExponential(4)} (bestAsk)`);
            const topTouchBuyOrderId = await this.placeBuyOrder(buyTouchPrice, buyTouchAmount);
            if (topTouchBuyOrderId) {
              placementsThisCycle++;
              buyPlacementsThisCycle++;
            }
          }
        }

        if (hasSellPlacementBudget() && !shouldPrioritizeBuysForDepth) {
          const sellTouchPrice = executableBestBid;
          const sellTouchUsd = this.getDynamicOrderUsdTarget(topTouchBaseUsd);
          const sellTouchRawAmount = sellTouchUsd / sellTouchPrice;
          const sellTouchAmount = this.normalizeOrderAmount(quantizeToStepSize(sellTouchRawAmount, this.stepSize), sellTouchPrice, availableSellUsd);
          if (sellTouchAmount !== null && this.isValidOrderAmount(sellTouchAmount, sellTouchPrice)) {
            logger.info(`🎯 Placing top-touch SELL: ${sellTouchAmount} EPWX @ ${sellTouchPrice.toExponential(4)} (bestBid)`);
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
            lowBookSellHeavyAfterTopTouch || (
              sellBuyGapAfterTopTouch >= VolumeGenerationStrategy.SELL_IMBALANCE_GUARD_MIN_GAP &&
              sellToBuyRatioAfterTopTouch >= VolumeGenerationStrategy.SELL_IMBALANCE_GUARD_MIN_RATIO
            );

          if (shouldPrioritizeBuysAfterTopTouch && !shouldPrioritizeBuysForDepth) {
            shouldPrioritizeBuysForDepth = true;
            logger.warn(
              `⚖️  Sell-side imbalance guard activated after top-touch refresh: openBook=${buyOrders.length} buys/${sellOrders.length} sells; suppressing additional sell placements this cycle.`
            );
          }
        }
      }

      // --- Order Depth Logic ---
      // Calculate cumulative buy orders between 98%-100% of mid-price
      const minBuyPrice = priceReference * 0.98;
      const maxBuyPrice = priceReference * 1.00;
      const minSellPrice = priceReference * 1.00;
      const maxSellPrice = priceReference * 1.02;

      const buyDepth = buyOrders
        .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
        .reduce((sum, o) => sum + o.price * o.amount, 0);
      const sellDepth = sellOrders
        .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
        .reduce((sum, o) => sum + o.price * o.amount, 0);

      logger.info(`📏 Buy depth (98%-100%): $${buyDepth.toFixed(2)} | Sell depth (100%-102%): $${sellDepth.toFixed(2)}`);


      // Place additional buy orders if needed to reach 200 USDT depth (business requirement)
      let buyDepthShortfall = 200 - buyDepth;
      if (buyDepthShortfall > 0) {
        logger.info(`🟢 Need to add $${buyDepthShortfall.toFixed(2)} buy orders in 98%-100% of Mid-Price (Business Support)`);
        // Place as many orders as needed to fill the gap, using safe order size
        let remaining = buyDepthShortfall;
        let supportBuysPlaced = 0;
        const maxSupportBuys = Math.max(targetOrdersPerSide - buyOrders.length, 0);
        while (remaining > 0 && supportBuysPlaced < maxSupportBuys && hasBuyPlacementBudget()) {
          const buyPrice = Math.max(minBuyPrice, Math.min(maxBuyPrice, priceReference * (1 - 0.01 * Math.random())));
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
          logger.info(`🟢 Placing depth buy order: ${buyOrderAmount} EPWX @ ${buyPrice.toExponential(4)} (98%-100% of Mid-Price)`);
          const buyOrderId = await this.placeBuyOrder(buyPrice, buyOrderAmount);
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

      // Place additional sell orders if needed to reach 200 USDT depth (business requirement)
      let sellDepthShortfall = 200 - sellDepth;
      if (sellDepthShortfall > 0) {
        if (shouldPrioritizeBuysForDepth) {
          logger.info('⏭️  Skipping depth sell additions this cycle because buy-side replenishment is prioritized.');
        }
      }

      if (sellDepthShortfall > 0 && !shouldPrioritizeBuysForDepth) {
        logger.info(`🔴 Need to add $${sellDepthShortfall.toFixed(2)} sell orders in 100%-102% of Mid-Price (Business Support)`);
        let remaining = sellDepthShortfall;
        let supportSellsPlaced = 0;
        const maxSupportSells = Math.max(targetOrdersPerSide - sellOrders.length, 0);
        while (remaining > 0 && supportSellsPlaced < maxSupportSells && hasSellPlacementBudget()) {
          const projectedBuyCount = buyOrders.length + buyPlacementsThisCycle;
          const projectedSellCount = sellOrders.length + sellPlacementsThisCycle;
          if (projectedBuyCount <= 2 && projectedSellCount >= projectedBuyCount) {
            logger.info(
              `⏭️  Stopping depth sell additions: projected openBook=${projectedBuyCount} buys/${projectedSellCount} sells in a sparse cycle.`
            );
            break;
          }

          const sellPrice = Math.max(minSellPrice, Math.min(maxSellPrice, priceReference * (1 + 0.01 * Math.random())));
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
          logger.info(`🔴 Placing depth sell order: ${sellOrderAmount} EPWX @ ${sellPrice.toExponential(4)} (100%-102% of Mid-Price)`);
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
      if (buyOrders.length < targetOrdersPerSide && hasBuyPlacementBudget()) {
        const needBuys = targetOrdersPerSide - buyOrders.length;
        for (let i = 0; i < needBuys && hasBuyPlacementBudget(); i++) {
          const buyPrice = priceReference * (1 - 0.01 - i * 0.0002); // 1% below reference, staggered
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
          const bookBuyOrderId = await this.placeBuyOrder(buyPrice, bookBuyAmount);
          if (!bookBuyOrderId) {
            break;
          }
          placementsThisCycle++;
          buyPlacementsThisCycle++;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      if (sellOrders.length < targetOrdersPerSide && hasSellPlacementBudget() && !shouldPrioritizeBuysForDepth) {
        const needSells = targetOrdersPerSide - sellOrders.length;
        for (let i = 0; i < needSells && hasSellPlacementBudget(); i++) {
          const projectedBuyCount = buyOrders.length + buyPlacementsThisCycle;
          const projectedSellCount = sellOrders.length + sellPlacementsThisCycle;
          if (projectedBuyCount <= 2 && projectedSellCount >= projectedBuyCount) {
            logger.info(
              `⏭️  Skipping book-depth sell additions: projected openBook=${projectedBuyCount} buys/${projectedSellCount} sells in a sparse cycle.`
            );
            break;
          }

          const sellPrice = priceReference * (1 + 0.01 + i * 0.0002); // 1% above reference, staggered
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
      const washFeatureEnabled = config.volumeStrategy.selfTradeEnabled && canRunWashTradesByDrift;
      const washTradePairs = washFeatureEnabled
        ? Math.min(
            dynamicWashTradePairs,
            Math.max(washPairsByRemainingSlots, 0),
            Math.max(washPairsByReservedBudget, 0)
          )
        : 0;
      this.washTradePairsActive = this.washTradePairsActive.filter(pair =>
        !this.settledWashOrderIds.has(pair.buyOrderId) && !this.settledWashOrderIds.has(pair.sellOrderId)
      );
      if (!config.volumeStrategy.selfTradeEnabled) {
        logger.info('⏭️  Wash trades disabled via SELF_TRADE_ENABLED=false');
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

  protected async placeBuyOrder(price: number, amount: number, isWashTrade: boolean = false): Promise<string | void> {
    try {
      // Check available USDT before placing order
      const balances = await this.exchange.getBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      const availableUSDT = usdtBalance?.free || 0;
      const normalizedAmount = this.applyOrderAmountCap(Math.floor(amount), 'BUY', price, availableUSDT);
      if (!this.isRunning || !Number.isFinite(price) || !Number.isFinite(normalizedAmount) || normalizedAmount < this.minQty) {
        logger.warn(`⚠️  Skipping buy order before placement: running=${this.isRunning}, amount=${normalizedAmount}, minQty=${this.minQty}, price=${price}`);
        return;
      }

      const orderValue = normalizedAmount * price;
      if (orderValue > availableUSDT) {
        logger.warn(`⚠️  Skipping buy order: requested $${orderValue.toFixed(2)} > available $${availableUSDT.toFixed(2)}`);
        return;
      }
      if (!this.isRunning) {
        logger.warn(`⚠️  Aborting buy order after balance check because the bot is stopping: amount=${normalizedAmount}, price=${price}`);
        return;
      }
      logger.debug(`Attempting to place buy order: ${normalizedAmount.toFixed(2)} @ ${price.toExponential(4)}`);
      const order = await this.exchange.placeOrder(
        this.symbol,
        'BUY',
        'LIMIT',
        normalizedAmount,
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
      logger.info(`✅ Buy order placed: ${normalizedAmount.toLocaleString()} EPWX @ $${price.toExponential(4)}`);
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
      // Check available EPWX before placing order
      const balances = await this.exchange.getBalances();
      const epwxBalance = balances.find(b => b.asset === 'EPWX');
      const availableEPWX = epwxBalance?.free || 0;
      const normalizedAmount = this.applyOrderAmountCap(Math.floor(amount), 'SELL', price, availableEPWX * price);
      if (!this.isRunning || !Number.isFinite(price) || !Number.isFinite(normalizedAmount) || normalizedAmount < this.minQty) {
        logger.warn(`⚠️  Skipping sell order before placement: running=${this.isRunning}, amount=${normalizedAmount}, minQty=${this.minQty}, price=${price}`);
        return;
      }

      if (normalizedAmount > availableEPWX) {
        logger.warn(`⚠️  Skipping sell order: requested ${normalizedAmount.toFixed(2)} EPWX > available ${availableEPWX.toFixed(2)} EPWX`);
        return;
      }
      if (!this.isRunning) {
        logger.warn(`⚠️  Aborting sell order after balance check because the bot is stopping: amount=${normalizedAmount}, price=${price}`);
        return;
      }
      logger.debug(`Attempting to place sell order: ${normalizedAmount.toFixed(2)} @ ${price.toExponential(4)}`);
      const order = await this.exchange.placeOrder(
        this.symbol,
        'SELL',
        'LIMIT',
        normalizedAmount,
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
      logger.info(`✅ Sell order placed: ${normalizedAmount.toLocaleString()} EPWX @ $${price.toExponential(4)}`);
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
        const filledAmount = trades.reduce((sum, trade) => sum + trade.amount, 0);
        const filledVolumeUSD = trades.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
        this.applyPositionForFilledOrder(orderId, side, filledAmount);
        if (isWashTrade) {
          this.settlePairedWashOrder(orderId, side, filledAmount, filledVolumeUSD);
        }
      } else {
        logger.info(`No fills detected for order ${orderId} (${side}) after 1s.`);
        await this.logNoFillDiagnostics(orderId, side);
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

          // Calculate profit from spread capture
          const originalPrice = this.orderPrices.get(orderId);
          const trackedAsWashPair = this.washTradePairsActive.some(pair => pair.buyOrderId === orderId || pair.sellOrderId === orderId);
          let profit = 0;
          let spreadPercent = 0;
          let isRealFill = true;

          if (originalPrice) {
            // Profit = actual fill price vs intended order price
            // For buys: higher fill price than intended = loss, lower = gain
            // For sells: lower fill price than intended = loss, higher = gain
            if (order.side === 'BUY') {
              profit = (originalPrice.price - order.price) * order.filled; // Profit when buying lower than intended
              spreadPercent = ((originalPrice.price - order.price) / originalPrice.price) * 100;
            } else {
              profit = (order.price - originalPrice.price) * order.filled; // Profit when selling higher than intended
              spreadPercent = ((order.price - originalPrice.price) / originalPrice.price) * 100;
            }

            // When self-trading is disabled, classify all fills as real fills.
            if (!config.volumeStrategy.selfTradeEnabled) {
              isRealFill = true;
            } else if (trackedAsWashPair) {
              isRealFill = false;
            } else {
              // Fallback heuristic when wash mode is enabled but order wasn't explicitly tracked.
              isRealFill = Math.abs(spreadPercent - 0.3) > 0.05; // More than 0.05% deviation = likely real fill
            }
          }

          this.profitStats.totalProfit += profit;
          if (isRealFill) {
            this.profitStats.realFills++;
            this.profitStats.profitFromRealFills += profit;
            logger.info(`💰 REAL FILL: ${order.side} ${order.filled.toFixed(0)} @ $${order.price.toExponential(4)} | Profit: $${profit.toFixed(4)} (${spreadPercent.toFixed(3)}%)`);
          } else {
            this.profitStats.washTrades++;
            logger.info(`🔄 WASH TRADE FILLED: ${order.side} ${order.filled.toFixed(0)} @ $${order.price.toExponential(4)}`);
          }

          if (profit > this.profitStats.bestProfit) {
            this.profitStats.bestProfit = profit;
          }

          // Update average spread captured
          const totalFills = this.profitStats.realFills + this.profitStats.washTrades;
          if (totalFills > 0) {
            this.profitStats.averageSpreadCaptured = Math.abs(spreadPercent);
            const runtimeHours = (Date.now() - this.volumeStats.startTime) / (1000 * 60 * 60);
            this.profitStats.estimatedDailyProfit = (this.profitStats.totalProfit / Math.max(runtimeHours, 0.01)) * 24;
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
    const totalEpwx = epwxBalance?.total ?? ((epwxBalance?.free || 0) + (epwxBalance?.locked || 0));

    if (!Number.isFinite(totalEpwx)) {
      return;
    }

    if (this.initialEpwxBalance === null) {
      this.initialEpwxBalance = totalEpwx;
      this.currentPosition = 0;
      logger.info(`📌 Position baseline initialized from EPWX balance: ${this.initialEpwxBalance.toFixed(0)}`);
      return;
    }

    this.currentPosition = totalEpwx - this.initialEpwxBalance;
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
      if (!trades.length) {
        return false;
      }

      const trackedOrder = this.activeOrders.get(orderId);
      const isWashTrade = this.washTradePairsActive.some(pair => pair.buyOrderId === orderId || pair.sellOrderId === orderId);
      const trackedOrderSide = trackedOrder?.side ?? (this.orderPrices.get(orderId)?.side as 'BUY' | 'SELL' | undefined);
      this.recordTrades(trades, orderId, isWashTrade, trackedOrderSide);

      if (trackedOrderSide) {
        const filledAmount = trades.reduce((sum, trade) => sum + trade.amount, 0);
        const filledVolumeUSD = trades.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
        this.applyPositionForFilledOrder(orderId, trackedOrderSide, filledAmount);
        if (isWashTrade) {
          this.settlePairedWashOrder(orderId, trackedOrderSide, filledAmount, filledVolumeUSD);
        }
      }

      return true;
    } catch (error) {
      logger.warn(`Could not fetch trades for completed order ${orderId}:`, error);
      return false;
    }
  }

  private async checkAndRebalancePosition(): Promise<void> {
    if (!config.risk.enablePositionLimits) return;

    const positionThreshold = config.marketMaking.positionRebalanceThreshold;

    if (Math.abs(this.currentPosition) > positionThreshold) {
      logger.warn(`⚖️ Position rebalance needed: ${this.currentPosition.toFixed(2)}`);

      try {
        // Cancel existing orders
        await this.exchange.cancelAllOrders(this.symbol);
        this.activeOrders.clear();

        // Place rebalancing order
        const ticker = await this.exchange.getTicker(this.symbol);
        const rebalanceAmount = this.normalizeOrderAmount(Math.abs(this.currentPosition) * 0.5); // Rebalance 50%

        if (rebalanceAmount === null) {
          logger.warn(`⚠️  Skipping rebalance because normalized amount is below minQty (${this.minQty})`);
          return;
        }

        if (this.currentPosition > 0) {
          // We have too much, sell
          await this.placeSellOrder(ticker.ask, rebalanceAmount);
          logger.info(`📉 Rebalancing: Selling ${rebalanceAmount.toFixed(2)}`);
        } else {
          // We're short, buy
          await this.placeBuyOrder(ticker.bid, rebalanceAmount);
          logger.info(`📈 Rebalancing: Buying ${rebalanceAmount.toFixed(2)}`);
        }
      } catch (error) {
        logger.error('Error rebalancing position:', error);
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
    logger.info(`  Total Profit: $${this.profitStats.totalProfit.toFixed(4)}`);
    logger.info(`  Real Fill Profit: $${this.profitStats.profitFromRealFills.toFixed(4)}`);
    logger.info(`  Avg Spread: ${this.profitStats.averageSpreadCaptured.toFixed(3)}%`);
    logger.info(`  Best Single Fill: $${this.profitStats.bestProfit.toFixed(4)}`);
    logger.info(`  Projected 24h Profit: $${this.profitStats.estimatedDailyProfit.toFixed(2)}`);
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
