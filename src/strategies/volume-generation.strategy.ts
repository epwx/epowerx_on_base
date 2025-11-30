import { BiconomyExchangeService, Order } from '../services/biconomy-exchange.service';
import { logger } from '../utils/logger';
import { config } from '../config';

interface VolumeStats {
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  orderCount: number;
  startTime: number;
  lastOrderTime: number;
}

/**
 * Volume Generation Strategy
 * Generates trading volume on Biconomy Exchange using zero-fee MM account
 */
export class VolumeGenerationStrategy {
  private exchange: BiconomyExchangeService;
  private isRunning: boolean = false;
  private symbol: string;
  private volumeStats: VolumeStats;
  private activeOrders: Map<string, Order> = new Map();
  private updateTimer?: NodeJS.Timeout;
  private orderTimer?: NodeJS.Timeout;
  private currentPosition: number = 0;

  constructor() {
    this.exchange = new BiconomyExchangeService();
    this.symbol = config.trading.pair;
    this.volumeStats = this.initializeStats();
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

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Volume generation strategy is already running');
      return;
    }

    logger.info('🚀 Starting Biconomy Exchange Volume Generation Bot...');
    logger.info(`Target: $${config.volumeStrategy.volumeTargetDaily.toLocaleString()} daily volume`);
    logger.info(`Pair: ${this.symbol}`);
    logger.info(`Spread: ${config.volumeStrategy.spreadPercentage}%`);
    logger.info(`Order Frequency: ${config.volumeStrategy.orderFrequency}ms`);

    this.isRunning = true;

    try {
      // Cancel any existing orders (ignore errors if endpoint not available)
      try {
        await this.exchange.cancelAllOrders(this.symbol);
        logger.info('Cancelled existing orders');
      } catch (error: any) {
        logger.warn('Could not cancel existing orders:', error.message);
      }

      // Get initial balances
      await this.logBalances();

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
      await this.exchange.cancelAllOrders(this.symbol);
      this.activeOrders.clear();
      
      await this.logFinalStats();
      logger.info('✅ Volume generation bot stopped');
    } catch (error) {
      logger.error('Error stopping bot:', error);
    }
  }

  private startOrderPlacementLoop(): void {
    this.orderTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.placeVolumeOrders();
      } catch (error) {
        logger.error('Error in order placement loop:', error);
      }
    }, config.volumeStrategy.orderFrequency);
  }

  private startMonitoringLoop(): void {
    this.updateTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.updateOrderStatus();
        await this.checkAndRebalancePosition();
        this.logPerformance();
      } catch (error) {
        logger.error('Error in monitoring loop:', error);
      }
    }, config.marketMaking.updateInterval);
  }

  private async placeVolumeOrders(): Promise<void> {
    try {
      const ticker = await this.exchange.getTicker(this.symbol);
      
      // Use last price if bid/ask are zero, otherwise use mid price
      let referencePrice = ticker.price;
      if (ticker.bid > 0 && ticker.ask > 0) {
        referencePrice = (ticker.bid + ticker.ask) / 2;
      }

      // If no price data, skip this round
      if (referencePrice === 0) {
        logger.warn('No price data available, skipping orders');
        return;
      }

      // Calculate order size (randomized for natural appearance)
      const orderSize = this.randomizeOrderSize();

      // Calculate buy and sell prices with spread (wider spread to stay within 50-150% range)
      const spreadMultiplier = Math.max(config.volumeStrategy.spreadPercentage / 100, 0.02); // Minimum 2% spread
      const buyPrice = referencePrice * (1 - spreadMultiplier);
      const sellPrice = referencePrice * (1 + spreadMultiplier);

      logger.debug(`Reference price: $${referencePrice.toExponential(2)}, Buy: $${buyPrice.toExponential(2)}, Sell: $${sellPrice.toExponential(2)}`);

      // Check position limits before placing orders
      if (config.risk.enablePositionLimits) {
        const canBuy = Math.abs(this.currentPosition + orderSize) <= config.marketMaking.maxPositionSize;
        const canSell = Math.abs(this.currentPosition - orderSize) <= config.marketMaking.maxPositionSize;

        if (!canBuy && !canSell) {
          logger.warn('Position limits reached, skipping orders');
          return;
        }

        // Place orders based on position limits
        if (canBuy) {
          await this.placeBuyOrder(buyPrice, orderSize);
        }

        if (canSell) {
          await this.placeSellOrder(sellPrice, orderSize);
        }
      } else {
        // Place both orders without position limits
        await Promise.all([
          this.placeBuyOrder(buyPrice, orderSize),
          this.placeSellOrder(sellPrice, orderSize),
        ]);
      }

      this.volumeStats.lastOrderTime = Date.now();
    } catch (error) {
      logger.error('Error placing volume orders:', error);
    }
  }

  private async placeBuyOrder(price: number, amount: number): Promise<void> {
    try {
      const order = await this.exchange.placeOrder(
        this.symbol,
        'BUY',
        'LIMIT',
        amount,
        price
      );

      this.activeOrders.set(order.orderId, order);
      this.volumeStats.orderCount++;

      logger.debug(`📊 Buy order placed: ${amount} @ $${price.toFixed(6)}`);
    } catch (error) {
      logger.error('Error placing buy order:', error);
    }
  }

  private async placeSellOrder(price: number, amount: number): Promise<void> {
    try {
      const order = await this.exchange.placeOrder(
        this.symbol,
        'SELL',
        'LIMIT',
        amount,
        price
      );

      this.activeOrders.set(order.orderId, order);
      this.volumeStats.orderCount++;

      logger.debug(`📊 Sell order placed: ${amount} @ $${price.toFixed(6)}`);
    } catch (error) {
      logger.error('Error placing sell order:', error);
    }
  }

  private randomizeOrderSize(): number {
    const { minOrderSize, maxOrderSize } = config.volumeStrategy;
    const range = maxOrderSize - minOrderSize;
    return minOrderSize + Math.random() * range;
  }

  private async updateOrderStatus(): Promise<void> {
    const orderIds = Array.from(this.activeOrders.keys());

    for (const orderId of orderIds) {
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

          logger.info(`✅ Order filled: ${order.side} ${order.filled} @ $${order.price.toFixed(6)} | Volume: $${volumeUSD.toFixed(2)}`);
          
          this.activeOrders.delete(orderId);
        } else if (order.status === 'CANCELED') {
          this.activeOrders.delete(orderId);
        }
      } catch (error) {
        logger.error(`Error checking order ${orderId}:`, error);
        this.activeOrders.delete(orderId);
      }
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
        const rebalanceAmount = Math.abs(this.currentPosition) * 0.5; // Rebalance 50%

        if (this.currentPosition > 0) {
          // We have too much, sell
          await this.exchange.placeOrder(
            this.symbol,
            'SELL',
            'LIMIT',
            rebalanceAmount,
            ticker.ask
          );
          logger.info(`📉 Rebalancing: Selling ${rebalanceAmount.toFixed(2)}`);
        } else {
          // We're short, buy
          await this.exchange.placeOrder(
            this.symbol,
            'BUY',
            'LIMIT',
            rebalanceAmount,
            ticker.bid
          );
          logger.info(`📈 Rebalancing: Buying ${rebalanceAmount.toFixed(2)}`);
        }
      } catch (error) {
        logger.error('Error rebalancing position:', error);
      }
    }
  }

  private logPerformance(): void {
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
