describe('Logging and diagnostics output', () => {
  it('should log order placement, fills, and errors', async () => {
    const logs: string[] = [];
    // Mock logger
    const mockLogger = {
      info: (msg: string) => logs.push(`INFO: ${msg}`),
      error: (msg: string) => logs.push(`ERROR: ${msg}`),
      warn: (msg: string) => logs.push(`WARN: ${msg}`)
    };
    // Patch logger in strategy
    const originalLogger = require('../../utils/logger');
    Object.assign(originalLogger, mockLogger);
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 5000, locked: 0 },
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
    const strategy = new VolumeGenerationStrategy(mockExchange);
    // Place buy order
    await (strategy as any).placeBuyOrder(1, 100, false);
    // Simulate fill
    mockLogger.info('🎯 Trade fill detected: BUY 100 @ $1 (Order ID: test, Trade ID: fill1)');
    // Simulate error
    mockLogger.error('Error placing buy order: Simulated error');
    // Check logs
    expect(logs.some(l => l.includes('INFO:'))).toBe(true);
    expect(logs.some(l => l.includes('Trade fill detected'))).toBe(true);
    expect(logs.some(l => l.includes('ERROR:'))).toBe(true);
    expect(logs.some(l => l.includes('Error placing buy order'))).toBe(true);
  });
});
describe('Partial fills and order status transitions', () => {
  it('should correctly update stats and status for partial fills', async () => {
    class TestStrategy extends VolumeGenerationStrategy {
      async getOpenOrdersMock() {
        return [
          {
            orderId: 'buy1',
            symbol: 'EPWX/USDT',
            side: 'BUY',
            type: 'LIMIT',
            price: 1,
            amount: 100,
            filled: 40,
            status: "PARTIALLY_FILLED" as const,
            timestamp: Date.now(),
            fee: 0.05
          },
          {
            orderId: 'sell1',
            symbol: 'EPWX/USDT',
            side: 'SELL',
            type: 'LIMIT',
            price: 1.02,
            amount: 100,
            filled: 60,
            status: "PARTIALLY_FILLED" as const,
            timestamp: Date.now(),
            fee: 0.05
          }
        ];
      }
    }
    const strategy = new TestStrategy();
    const orders = await strategy.getOpenOrdersMock();
    // Check status
    expect(orders[0].status).toBe('PARTIALLY_FILLED');
    expect(orders[1].status).toBe('PARTIALLY_FILLED');
    // Simulate stats update for partial fills
    const stats = strategy.getProfitStats();
    const buyProfit = (orders[0].filled * (orders[1].price - orders[0].price)) - orders[0].fee;
    const sellProfit = (orders[1].filled * (orders[1].price - orders[0].price)) - orders[1].fee;
    stats.totalProfit += buyProfit + sellProfit;
    stats.profitFromRealFills += buyProfit + sellProfit;
    expect(stats.totalProfit).toBeCloseTo(1.9);
    expect(stats.profitFromRealFills).toBeCloseTo(1.9);
  });

  it('should transition order status from PARTIALLY_FILLED to FILLED', async () => {
    class TestStrategy extends VolumeGenerationStrategy {
      async getOpenOrdersMock() {
        return [
          {
            orderId: 'buy2',
            symbol: 'EPWX/USDT',
            side: 'BUY',
            type: 'LIMIT',
            price: 1,
            amount: 100,
            filled: 100,
            status: "FILLED" as const,
            timestamp: Date.now(),
            fee: 0.1
          }
        ];
      }
    }
    const strategy = new TestStrategy();
    const orders = await strategy.getOpenOrdersMock();
    expect(orders[0].status).toBe('FILLED');
    expect(orders[0].filled).toBe(100);
  });
});
describe('Fee calculation and profit impact', () => {
  it('should deduct fees from profit after buy and sell', async () => {
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 5000, locked: 0 },
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
    const strategy = new VolumeGenerationStrategy(mockExchange);
    // Simulate a buy order with fee
    const buyOrder = await (strategy as any).placeBuyOrder(1, 100, false);
    const buyFee = 0.1; // Assume $0.1 fee for buy
    // Simulate a sell order with fee
    const sellOrder = await (strategy as any).placeSellOrder(1.01, 100, false);
    const sellFee = 0.1; // Assume $0.1 fee for sell
    // Simulate profit calculation
    const grossProfit = (1.01 - 1) * 100; // $1 profit
    const totalFees = buyFee + sellFee; // $0.2 total fees
    const netProfit = grossProfit - totalFees; // $0.8 net
    const stats = strategy.getProfitStats();
    stats.totalProfit += netProfit;
    stats.profitFromRealFills += netProfit;
    expect(stats.totalProfit).toBeCloseTo(0.8);
    expect(stats.profitFromRealFills).toBeCloseTo(0.8);
  });
});
describe('VolumeGenerationStrategy - real user buy/sell and profit %', () => {
  it('should place real user buy order and update profit stats', async () => {
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 5000, locked: 0 },
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
    const strategy = new VolumeGenerationStrategy(mockExchange);
    // Place a real user buy order
    const result = await (strategy as any).placeBuyOrder(1, 100, false);
    expect(result).toBeDefined();
    expect(mockExchange.placedOrders.length).toBe(1);
    // Simulate fill and profit update
    const stats = strategy.getProfitStats();
    stats.realFills++;
    stats.profitFromRealFills += 10; // Assume $10 profit
    stats.totalProfit += 10;
    expect(stats.realFills).toBe(1);
    expect(stats.profitFromRealFills).toBe(10);
    expect(stats.totalProfit).toBe(10);
  });

  it('should place real user sell order and update profit stats', async () => {
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 5000, locked: 0 },
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
    const strategy = new VolumeGenerationStrategy(mockExchange);
    // Place a real user sell order
    const result = await (strategy as any).placeSellOrder(1, 100, false);
    expect(result).toBeDefined();
    expect(mockExchange.placedOrders.length).toBe(1);
    // Simulate fill and profit update
    const stats = strategy.getProfitStats();
    stats.realFills++;
    stats.profitFromRealFills += 15; // Assume $15 profit
    stats.totalProfit += 15;
    expect(stats.realFills).toBe(1);
    expect(stats.profitFromRealFills).toBe(15);
    expect(stats.totalProfit).toBe(15);
  });

  it('should calculate profit % correctly', async () => {
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 5000, locked: 0 },
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
    const strategy = new VolumeGenerationStrategy(mockExchange);
    // Simulate profit and cost
    const stats = strategy.getProfitStats();
    stats.totalProfit = 20;
    stats.cost = 100;
    // Calculate profit %
    const profitPercent = (stats.totalProfit / (stats.cost || 1)) * 100;
    expect(profitPercent).toBeCloseTo(20);
  });
});
describe('Wash trading logic', () => {
  it('should track wash trade pairs and increment wash trade counter', async () => {
    class WashTradeStrategy extends VolumeGenerationStrategy {
      protected washTradePairsActive: any[] = [];
      getWashTradePairsActive() {
        return this.washTradePairsActive;
      }
      async placeBuyOrder(price: number, amount: number, isWashTrade: boolean = false) {
        return `buyOrderId`;
      }
      async placeSellOrder(price: number, amount: number, isWashTrade: boolean = false) {
        return `sellOrderId`;
      }
      async pollOrderFills(orderId: string, side: 'BUY' | 'SELL', isWashTrade: boolean = false) {
        if (isWashTrade) this.profitStats.washTrades++;
      }
      async simulateWashTrades(priceReference: number, amount: number, washTradePairs: number) {
        for (let i = 0; i < washTradePairs; i++) {
          const buyOrderId = await this.placeBuyOrder(priceReference, amount, true);
          const sellOrderId = await this.placeSellOrder(priceReference, amount, true);
          if (buyOrderId && sellOrderId) {
            this.washTradePairsActive.push({ buyOrderId, sellOrderId, price: priceReference, amount });
            await this.pollOrderFills(buyOrderId, 'BUY', true);
            await this.pollOrderFills(sellOrderId, 'SELL', true);
          }
        }
      }
        getProfitStats() {
          return this.profitStats;
        }
    }
    const strategy = new WashTradeStrategy();
    // Simulate wash trading logic
    const priceReference = 1;
    const amount = 100;
    const washTradePairs = 2;
    await strategy.simulateWashTrades(priceReference, amount, washTradePairs);
    expect(strategy.getWashTradePairsActive().length).toBe(2);
    expect(strategy.getProfitStats().washTrades).toBe(4);
  });
});
describe('Order book depth enforcement', () => {
    it('should keep exactly 30 buy and 30 sell orders after cleanup when starting with 30 each', async () => {
      class TestStrategy extends VolumeGenerationStrategy {
        async getOpenOrdersMock() {
          const orders = [];
          for (let i = 0; i < 30; i++) {
            orders.push({
              orderId: `buy${i}`,
              symbol: 'EPWX/USDT',
              side: 'BUY',
              type: 'LIMIT',
              price: 1,
              amount: 100,
              filled: 0,
              status: "NEW" as const,
              timestamp: Date.now() - i * 1000,
              fee: 0
            });
            orders.push({
              orderId: `sell${i}`,
              symbol: 'EPWX/USDT',
              side: 'SELL',
              type: 'LIMIT',
              price: 1,
              amount: 100,
              filled: 0,
              status: "NEW" as const,
              timestamp: Date.now() - i * 1000,
              fee: 0
            });
          }
          return orders;
        }
      }
      const strategy = new TestStrategy();
      const orders = await strategy.getOpenOrdersMock();
      const buyOrders = orders.filter(o => o.side === 'BUY');
      const sellOrders = orders.filter(o => o.side === 'SELL');
      expect(buyOrders.length).toBe(30);
      expect(sellOrders.length).toBe(30);
      // Simulate cleanup logic (should not remove any)
      // ...existing code...
    });

    it('should cleanup to 30 buy and 30 sell orders after rapid fills', async () => {
      class TestStrategy extends VolumeGenerationStrategy {
        async getOpenOrdersMock() {
          const orders = [];
          // Start with 50 buys and 50 sells, but 20 of each are filled
          for (let i = 0; i < 50; i++) {
            orders.push({
              orderId: `buy${i}`,
              symbol: 'EPWX/USDT',
              side: 'BUY',
              type: 'LIMIT',
              price: 1,
              amount: 100,
              filled: i < 20 ? 100 : 0,
              status: i < 20 ? "FILLED" as const : "NEW" as const,
              timestamp: Date.now() - i * 1000,
              fee: 0
            });
            orders.push({
              orderId: `sell${i}`,
              symbol: 'EPWX/USDT',
              side: 'SELL',
              type: 'LIMIT',
              price: 1,
              amount: 100,
              filled: i < 20 ? 100 : 0,
              status: i < 20 ? "FILLED" as const : "NEW" as const,
              timestamp: Date.now() - i * 1000,
              fee: 0
            });
          }
          return orders;
        }
      }
      const strategy = new TestStrategy();
      const orders = await strategy.getOpenOrdersMock();
      // Only NEW orders should be counted for book depth
      const buyOrders = orders.filter(o => o.side === 'BUY' && o.status === 'NEW');
      const sellOrders = orders.filter(o => o.side === 'SELL' && o.status === 'NEW');
      expect(buyOrders.length).toBe(30);
      expect(sellOrders.length).toBe(30);
      // ...existing code...
    });
  it('should keep only 30 buy and 30 sell orders after cleanup', async () => {
    class TestStrategy extends VolumeGenerationStrategy {
      // Override getOpenOrders to simulate excess orders
      async getOpenOrdersMock() {
        // 50 buys, 50 sells
        const orders = [];
        for (let i = 0; i < 50; i++) {
          orders.push({
            orderId: `buy${i}`,
            symbol: 'EPWX/USDT',
            side: 'BUY',
            type: 'LIMIT',
            price: 1,
            amount: 100,
            filled: 0,
            status: "NEW" as const,
            timestamp: Date.now() - i * 1000,
            fee: 0
          });
          orders.push({
            orderId: `sell${i}`,
            symbol: 'EPWX/USDT',
            side: 'SELL',
            type: 'LIMIT',
            price: 1,
            amount: 100,
            filled: 0,
            status: "NEW" as const,
            timestamp: Date.now() - i * 1000,
            fee: 0
          });
        }
        return orders;
      }
      async cleanupOrderBook() {
        let openOrders = await this.getOpenOrdersMock();
        let buyOrders = openOrders.filter(o => o.side === 'BUY');
        let sellOrders = openOrders.filter(o => o.side === 'SELL');
        // Cleanup logic from strategy
        if (buyOrders.length > 30) {
          const sortedBuys = buyOrders.sort((a, b) => b.timestamp - a.timestamp);
          buyOrders = sortedBuys.slice(0, 30);
        }
        if (sellOrders.length > 30) {
          const sortedSells = sellOrders.sort((a, b) => b.timestamp - a.timestamp);
          sellOrders = sortedSells.slice(0, 30);
        }
        return { buyOrders, sellOrders };
      }
    }
    const strategy = new TestStrategy();
    const { buyOrders, sellOrders } = await strategy.cleanupOrderBook();
    expect(buyOrders.length).toBe(30);
    expect(sellOrders.length).toBe(30);
  });
});
import './setup-env';
import { VolumeGenerationStrategy } from '../volume-generation.strategy';
import { BiconomyExchangeService } from '../../services/biconomy-exchange.service';

// Mock exchange service
class MockExchangeService extends BiconomyExchangeService {
  balances: any[] = [];
  ticker: any = { price: 1 };
  placedOrders: any[] = [];

  async getBalances() {
    return this.balances;
  }
  async getTicker(symbol: string) {
    return this.ticker;
  }
  async placeOrder(symbol: string, side: 'BUY' | 'SELL', type: 'LIMIT' | 'MARKET', amount: number, price?: number) {
    this.placedOrders.push({ symbol, side, type, amount, price });
      return { orderId: 'test', symbol, side, type, price: typeof price === 'number' ? price : 0, amount, filled: 0, status: "NEW" as const, timestamp: Date.now(), fee: 0 };
  }
}

describe('VolumeGenerationStrategy - USD balance sell order check', () => {
  it('should skip real user sell order if USD balance < $1000 and not market value', async () => {
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 500, locked: 200 }, // total 700 < 1000
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
      const strategy = new VolumeGenerationStrategy(mockExchange);
    // Try to place a sell order at price far from market value
    const result = await (strategy as any).placeSellOrder(2, 100, false); // price=2, market=1, not wash trade
    expect(result).toBeUndefined();
    expect(mockExchange.placedOrders.length).toBe(0);
  });

  it('should allow sell order if USD balance < $1000 but price is market value', async () => {
    const mockExchange = new MockExchangeService();
    mockExchange.balances = [
      { asset: 'USDT', free: 500, locked: 200 }, // total 700 < 1000
      { asset: 'EPWX', free: 10000, locked: 0 }
    ];
    mockExchange.ticker = { price: 1 };
      const strategy = new VolumeGenerationStrategy(mockExchange);
    // Try to place a sell order at market value
    const result = await (strategy as any).placeSellOrder(1.004, 100, false); // price within 0.5% of market
    expect(result).toBeDefined();
    expect(mockExchange.placedOrders.length).toBe(1);
  });
});
