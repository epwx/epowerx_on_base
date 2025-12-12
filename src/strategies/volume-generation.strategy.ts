import { BiconomyExchangeService, Order } from '../services/biconomy-exchange.service';
import { logger } from '../utils/logger';
import { config } from '../config';
import { computeSafeOrderSizeUSD } from '../utils/order-guard';

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
  private exchange: BiconomyExchangeService;
  private isRunning: boolean = false;
  private symbol: string;
  private volumeStats: VolumeStats;
  private profitStats: ProfitStats;
  private activeOrders: Map<string, Order> = new Map();
  private orderPrices: Map<string, { side: string; price: number }> = new Map(); // Track original order prices for profit calculation
  private updateTimer?: NodeJS.Timeout;
  private orderTimer?: NodeJS.Timeout;
  private currentPosition: number = 0;
  private readonly FEE_BUFFER_USD = 0.5; // Fee buffer for order guard

  constructor() {
    this.exchange = new BiconomyExchangeService();
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
    
    // Check available balance
    const balances = await this.exchange.getBalances();
    const usdtBalance = balances.find(b => b.asset === 'USDT');
    const freeUSDT = usdtBalance?.free || 0;
    
    logger.info(`💰 Available USDT balance: $${freeUSDT.toFixed(2)}`);
    
    // Calculate reserved USD from active orders
    const reservedForActiveOrdersUSD = this.calculateReservedUSD(lastPrice);
    
    logger.info(`💼 Reserved for active orders: $${reservedForActiveOrdersUSD.toFixed(2)}`);
    
    // Use order guard to compute safe order size
    const totalOrdersNeeded = needBuys + needSells;
    const guardResult = computeSafeOrderSizeUSD({
      freeUSDT,
      totalOrdersToPlace: totalOrdersNeeded,
      reservedForActiveOrdersUSD,
      feeBufferUSD: this.FEE_BUFFER_USD,
    });
    
    if (!guardResult.allowed) {
      logger.warn(`⚠️  Order guard blocked order placement: ${guardResult.reason}`);
      return;
    }
    
    const safeOrderSizeUSD = guardResult.perOrderUSD;
    logger.info(`🔧 Order guard approved: $${safeOrderSizeUSD.toFixed(2)} per order (usable: $${guardResult.usableUSD.toFixed(2)})`);
    
    const targetSpread = 0.003; // 0.3% spread around last price
    
    // Place buy orders with staggered prices
    for (let i = 0; i < needBuys; i++) {
      const priceOffset = 1 - targetSpread - (i * 0.0001); // 0.3% below, then 0.31%, 0.32%...
      const buyPrice = lastPrice * priceOffset;
      const amount = safeOrderSizeUSD / buyPrice;
      
      // Skip if amount is not valid
      if (!this.isValidOrderAmount(amount)) {
        logger.warn(`⚠️  Skipping buy order ${i+1}: amount too small (${amount.toFixed(6)})`);
        continue;
      }
      
      logger.info(`🛒 [${i+1}/${needBuys}] Placing buy order: ${amount.toFixed(2)} EPWX @ ${buyPrice.toExponential(4)} (~$${safeOrderSizeUSD.toFixed(2)})`);
      await this.placeBuyOrder(buyPrice, amount);
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
    }
    
    // Place sell orders with staggered prices
    for (let i = 0; i < needSells; i++) {
      const priceOffset = 1 + targetSpread + (i * 0.0001); // 0.3% above, then 0.31%, 0.32%...
      const sellPrice = lastPrice * priceOffset;
      const amount = safeOrderSizeUSD / sellPrice;
      
      // Skip if amount is not valid
      if (!this.isValidOrderAmount(amount)) {
        logger.warn(`⚠️  Skipping sell order ${i+1}: amount too small (${amount.toFixed(6)})`);
        continue;
      }
      
      logger.info(`💰 [${i+1}/${needSells}] Placing sell order: ${amount.toFixed(2)} EPWX @ ${sellPrice.toExponential(4)} (~$${safeOrderSizeUSD.toFixed(2)})`);
      await this.placeSellOrder(sellPrice, amount);
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
    }
    
    logger.info(`✅ fillOrderBook complete: placed ${needBuys} buys and ${needSells} sells`);
  }

  private async executeWashTrade(lastPrice: number): Promise<void> {
    try {
      // Check available USDT for wash trade
      const balances = await this.exchange.getBalances();
      const usdtBalance = balances.find(b => b.asset === 'USDT');
      const freeUSDT = usdtBalance?.free || 0;
      
      // Calculate reserved USD from active orders
      const reservedForActiveOrdersUSD = this.calculateReservedUSD(lastPrice);
      
      // Calculate usable USDT after fee buffer and reservations
      const usableUSDT = Math.max(0, freeUSDT - this.FEE_BUFFER_USD - reservedForActiveOrdersUSD);
      
      logger.info(`💰 Wash trade balance check: free=$${freeUSDT.toFixed(2)}, reserved=$${reservedForActiveOrdersUSD.toFixed(2)}, usable=$${usableUSDT.toFixed(2)}`);
      
      // Need at least $0.10 to execute a wash trade (very minimal)
      if (usableUSDT < 0.10) {
        logger.warn(`⚠️  Cannot execute wash trade - insufficient usable USDT ($${usableUSDT.toFixed(2)})`);
        return;
      }
      
      // Scale wash trade size based on available USDT
      let washSizeUSD: number;
      if (usableUSDT >= 10) {
        washSizeUSD = 8 + Math.random() * 7; // $8-15 USD if plenty available
      } else if (usableUSDT >= 5) {
        washSizeUSD = 3 + Math.random() * 2; // $3-5 USD if moderate
      } else if (usableUSDT >= 1) {
        washSizeUSD = 0.5 + Math.random() * 0.4; // $0.5-0.9 USD if low
      } else {
        washSizeUSD = usableUSDT * 0.5; // Use 50% of what's left
      }
      
      // Ensure wash trade doesn't exceed usable USDT (need 2x for buy+sell)
      const maxWashSize = usableUSDT * 0.4; // Use 40% max (since we need buy+sell)
      washSizeUSD = Math.min(washSizeUSD, maxWashSize);
      
      // Skip if wash trade size is too small
      if (washSizeUSD < 0.10) {
        logger.warn(`⚠️  Wash trade size too small ($${washSizeUSD.toFixed(2)}), skipping`);
        return;
      }
      
      // Add small random price variation (±0.1%) to look natural
      const priceVariation = 1 + (Math.random() - 0.5) * 0.002; // ±0.1%
      const buyPrice = lastPrice * priceVariation;
      const sellPrice = lastPrice * priceVariation; // Same price to ensure matching
      
      // Slightly vary the amounts (±5%) to look more organic
      const buyAmountVariation = 1 + (Math.random() - 0.5) * 0.1; // ±5%
      const sellAmountVariation = 1 + (Math.random() - 0.5) * 0.1; // ±5%
      
      const buyAmount = (washSizeUSD / buyPrice) * buyAmountVariation;
      const sellAmount = (washSizeUSD / sellPrice) * sellAmountVariation;
      
      // Skip if amounts are not valid
      if (!this.isValidOrderAmount(buyAmount) || !this.isValidOrderAmount(sellAmount)) {
        logger.warn(`⚠️  Wash trade amounts too small (buy: ${buyAmount.toFixed(6)}, sell: ${sellAmount.toFixed(6)}), skipping`);
        return;
      }
      
      logger.info(`🔄 Wash trade: Buy ${Math.floor(buyAmount).toLocaleString()} @ $${buyPrice.toExponential(4)}, Sell ${Math.floor(sellAmount).toLocaleString()} @ $${sellPrice.toExponential(4)} (~$${washSizeUSD.toFixed(2)} each)`);
      
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
      this.orderPrices.set(order.orderId, { side: 'BUY', price });
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
      this.orderPrices.set(order.orderId, { side: 'SELL', price });
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

  /**
   * Calculate total USD value reserved by active orders
   */
  private calculateReservedUSD(lastPrice: number): number {
    let reservedUSD = 0;
    for (const [orderId, order] of this.activeOrders.entries()) {
      const orderInfo = this.orderPrices.get(orderId);
      const price = orderInfo ? orderInfo.price : lastPrice;
      // For buy orders, we reserve the USD value; for sell orders, we don't reserve USDT
      if (order.side === 'BUY') {
        reservedUSD += order.amount * price;
      }
    }
    return reservedUSD;
  }

  /**
   * Check if an order amount is valid (not zero or too small after rounding)
   */
  private isValidOrderAmount(amount: number): boolean {
    return amount > 0 && Math.floor(amount) > 0;
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

          // Calculate profit from spread capture
          const originalPrice = this.orderPrices.get(orderId);
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

            // If spread is close to 0.3%, likely a wash trade fill; otherwise real user
            isRealFill = Math.abs(spreadPercent - 0.3) > 0.05; // More than 0.05% deviation = likely real fill
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
        // Order not found or already completed - remove from tracking
        if (error.message?.includes('not found') || error.message?.includes('already completed')) {
          logger.debug(`Order ${orderId} no longer available (already filled/canceled), removing from tracking`);
          this.activeOrders.delete(orderId);
        } else {
          logger.error(`Error checking order ${orderId}:`, error);
          this.activeOrders.delete(orderId);
        }
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
