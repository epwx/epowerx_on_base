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
    
    // Check if ORDER_FREQUENCY is too high (potential misconfiguration)
    if (config.volumeStrategy.orderFrequency > 60000) {
      logger.warn(`⚠️  WARNING: ORDER_FREQUENCY is ${config.volumeStrategy.orderFrequency}ms (${(config.volumeStrategy.orderFrequency/1000).toFixed(1)}s) - this is very slow!`);
      logger.warn(`   To place orders every 5 seconds, set ORDER_FREQUENCY=5000 in your .env file`);
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
    logger.info(`📅 Order placement loop starting with frequency: ${config.volumeStrategy.orderFrequency}ms`);
    
    this.orderTimer = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        logger.info('▶️  Calling placeVolumeOrders...');
        await this.placeVolumeOrders();
      } catch (error) {
        logger.error('❌ Error in order placement loop:', error);
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
      logger.info('🔄 Starting order placement cycle');
      
      let ticker;
      try {
        ticker = await this.exchange.getTicker(this.symbol);
        logger.info(`✅ Got ticker: price=${ticker?.price}, bid=${ticker?.bid}, ask=${ticker?.ask}`);
      } catch (error) {
        logger.error('❌ Failed to get ticker:', error);
        return;
      }
      
      if (!ticker) {
        logger.error('❌ Ticker is undefined - API call failed');
        return;
      }
      
      logger.info(`📈 Ticker: last=${ticker.price.toExponential(4)}, bid=${ticker.bid.toExponential(4)}, ask=${ticker.ask.toExponential(4)}`);
      
      const lastPrice = ticker.price;
      if (!lastPrice || lastPrice === 0) {
        logger.warn('⚠️  No valid price data available, skipping');
        return;
      }

      // STEP 1: Check current open orders
      let openOrders;
      try {
        openOrders = await this.exchange.getOpenOrders(this.symbol);
        logger.info(`✅ Got open orders: ${openOrders?.length || 0} total`);
      } catch (error) {
        logger.error('❌ Failed to get open orders:', error);
        return;
      }
      
      if (!openOrders) {
        logger.error('❌ Failed to get open orders - openOrders is undefined');
        return;
      }
      
      const buyOrders = openOrders.filter(o => o.side === 'BUY');
      const sellOrders = openOrders.filter(o => o.side === 'SELL');
      
      logger.info(`📊 Current orders: ${buyOrders.length} buys, ${sellOrders.length} sells (target: 20 each)`);
      
      const targetOrdersPerSide = 20;
      
      // STEP 2: If we need more orders, place them
      if (buyOrders.length < targetOrdersPerSide || sellOrders.length < targetOrdersPerSide) {
        const needBuys = targetOrdersPerSide - buyOrders.length;
        const needSells = targetOrdersPerSide - sellOrders.length;
        
        logger.info(`🔨 Need to place: ${needBuys} buy orders and ${needSells} sell orders`);
        await this.fillOrderBook(lastPrice, needBuys, needSells);
      } 
      // STEP 3: If we have enough orders, do wash trade
      else {
        logger.info(`✅ Target orders reached. Executing wash trade...`);
        await this.executeWashTrade(lastPrice);
      }

      this.volumeStats.lastOrderTime = Date.now();
    } catch (error) {
      logger.error('💥 Unexpected error in placeVolumeOrders:', error);
    }
  }

  private async fillOrderBook(lastPrice: number, needBuys: number, needSells: number): Promise<void> {
    logger.info(`📚 fillOrderBook called: placing ${needBuys} buys and ${needSells} sells`);
    const targetSpread = 0.003; // 0.3% spread around last price
    
    // Place buy orders with staggered prices
    for (let i = 0; i < needBuys; i++) {
      const priceOffset = 1 - targetSpread - (i * 0.0001); // 0.3% below, then 0.31%, 0.32%...
      const buyPrice = lastPrice * priceOffset;
      const orderSizeUSD = this.randomizeOrderSize();
      const amount = orderSizeUSD / buyPrice;
      
      logger.info(`🛒 [${i+1}/${needBuys}] Placing buy order: ${amount.toFixed(2)} @ ${buyPrice.toExponential(4)}`);
      await this.placeBuyOrder(buyPrice, amount);
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
    }
    
    // Place sell orders with staggered prices
    for (let i = 0; i < needSells; i++) {
      const priceOffset = 1 + targetSpread + (i * 0.0001); // 0.3% above, then 0.31%, 0.32%...
      const sellPrice = lastPrice * priceOffset;
      const orderSizeUSD = this.randomizeOrderSize();
      const amount = orderSizeUSD / sellPrice;
      
      logger.info(`💰 [${i+1}/${needSells}] Placing sell order: ${amount.toFixed(2)} @ ${sellPrice.toExponential(4)}`);
      await this.placeSellOrder(sellPrice, amount);
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
    }
    
    logger.info(`✅ fillOrderBook complete: placed ${needBuys} buys and ${needSells} sells`);
  }

  private async executeWashTrade(lastPrice: number): Promise<void> {
    try {
      // Natural-looking wash trades with varied amounts and slight price differences
      // With 0% fees, any price matching still costs $0
      
      // Randomize the wash trade size between $8-15 for variety
      const washSizeUSD = 8 + Math.random() * 7; // $8-15 USD
      
      // Add small random price variation (±0.1%) to look natural
      const priceVariation = 1 + (Math.random() - 0.5) * 0.002; // ±0.1%
      const buyPrice = lastPrice * priceVariation;
      const sellPrice = lastPrice * priceVariation; // Same price to ensure matching
      
      // Slightly vary the amounts (±5%) to look more organic
      const buyAmountVariation = 1 + (Math.random() - 0.5) * 0.1; // ±5%
      const sellAmountVariation = 1 + (Math.random() - 0.5) * 0.1; // ±5%
      
      const buyAmount = (washSizeUSD / buyPrice) * buyAmountVariation;
      const sellAmount = (washSizeUSD / sellPrice) * sellAmountVariation;
      
      logger.info(`🔄 Wash trade: Buy ${Math.floor(buyAmount).toLocaleString()} @ $${buyPrice.toExponential(4)}, Sell ${Math.floor(sellAmount).toLocaleString()} @ $${sellPrice.toExponential(4)}`);
      
      // Small delay between buy and sell to look more natural (50-150ms)
      await this.placeBuyOrder(buyPrice, buyAmount);
      await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
      await this.placeSellOrder(sellPrice, sellAmount);
      
      const volumeGenerated = washSizeUSD * 2;
      logger.info(`✅ Wash trade complete! Volume: $${volumeGenerated.toFixed(2)}, Cost: ~$0 (0% fees)`);
      
    } catch (error) {
      logger.error('Error in wash trade:', error);
    }
  }

  private async placeBuyOrder(price: number, amount: number): Promise<void> {
    try {
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

      this.activeOrders.set(order.orderId, order);
      this.volumeStats.orderCount++;
      
      logger.info(`✅ Buy order placed: ${Math.floor(amount).toLocaleString()} EPWX @ $${price.toExponential(4)}`);
    } catch (error) {
      logger.error('Error placing buy order:', error);
    }
  }

  private async placeSellOrder(price: number, amount: number): Promise<void> {
    try {
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

      this.activeOrders.set(order.orderId, order);
      this.volumeStats.orderCount++;
      
      logger.info(`✅ Sell order placed: ${Math.floor(amount).toLocaleString()} EPWX @ $${price.toExponential(4)}`);
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
