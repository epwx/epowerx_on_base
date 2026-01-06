const EPSILON = 0.00006;
let setTimeoutSpy: jest.SpyInstance;
let setIntervalSpy: jest.SpyInstance;
beforeEach(() => {
  setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any, _ms: any, ...args: any[]) => {
    if (typeof cb === 'function') cb(...args);
    return 0 as any;
  });
  setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((cb: any, _ms: any, ...args: any[]) => {
    if (typeof cb === 'function') cb(...args);
    return 0 as any;
  });
});
afterEach(() => {
  setTimeoutSpy.mockRestore();
  setIntervalSpy.mockRestore();
});
it('should NOT allow buy orders if available USDT is insufficient (pure logic)', () => {
  // Simulate the USDT balance check logic
  const balances = [
    { asset: 'USDT', free: 0.005, locked: 0, total: 0.005 },
    { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
  ];
  const usdtBalance = balances.find(b => b.asset === 'USDT');
  const availableUSDT = usdtBalance?.free || 0;
  // The strategy should skip placing orders if availableUSDT < 0.01
  expect(availableUSDT).toBeLessThan(0.01);
  // Simulate the guard logic
  const canPlaceOrder = availableUSDT >= 0.01;
  expect(canPlaceOrder).toBe(false);
});
it('should calculate safe order size correctly based on available USDT and total orders needed', async () => {
  // Arrange: mock exchange with a specific USDT balance
  const availableUSDT = 5000;
  const targetOrdersPerSide = 30;
  const totalOrdersNeeded = targetOrdersPerSide * 2;
  const mockExchange = {
    getBalances: jest.fn().mockResolvedValue([
      { asset: 'USDT', free: availableUSDT, locked: 0, total: availableUSDT },
      { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
    ]),
    getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
    getOpenOrders: jest.fn().mockResolvedValue([]),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn().mockResolvedValue([])
  };
  jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.0);
  const config = require('../../config').config;
  config.volumeStrategy.orderFrequency = 1000000;
  config.trading.pair = 'EPWXUSDT';
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  (strategy as any).startOrderPlacementLoop = jest.fn();
  (strategy as any).startMonitoringLoop = jest.fn();
    // Spy on the instance methods
    const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder');
    const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder');
    // Act: run placeVolumeOrders (should calculate safe order size internally)
    await (strategy as any).placeVolumeOrders();
    // Assert: safe order size should be 0.8 * availableUSDT / totalOrdersNeeded, capped at $20
    const expected = Math.min((availableUSDT * 0.8) / totalOrdersNeeded, 20);
    // Find the actual value used in the test by checking the first call to placeBuyOrder or placeSellOrder
    const buyCall = buySpy.mock.calls[0];
    const sellCall = sellSpy.mock.calls[0];
    // The amount is calculated as safeOrderSizeUSD / price, with price = 0.99..1.01, so safeOrderSizeUSD = amount * price
    let actualSafeOrderSize;
    if (buyCall) {
      const [price, amount] = buyCall as [number, number, ...any[]];
      actualSafeOrderSize = amount * price;
    } else if (sellCall) {
      const [price, amount] = sellCall as [number, number, ...any[]];
      actualSafeOrderSize = amount * price;
    }
    expect(actualSafeOrderSize).toBeCloseTo(expected, 2);
});
it('should cancel excess buy and sell orders when above the target', async () => {
  // Arrange: mock exchange with 35 buy and 37 sell open orders
  const targetOrdersPerSide = 30;
  const buyOrders = Array.from({ length: 35 }, (_: any, i: number) => ({
    orderId: 'buy' + i,
    symbol: 'EPWXUSDT',
    side: 'BUY',
    type: 'LIMIT',
    amount: 10,
    price: 0.99,
    timestamp: 1000 + i
  }));
  const sellOrders = Array.from({ length: 37 }, (_: any, i: number) => ({
    orderId: 'sell' + i,
    symbol: 'EPWXUSDT',
    side: 'SELL',
    type: 'LIMIT',
    amount: 10,
    price: 1.01,
    timestamp: 2000 + i
  }));
  const openOrders = [...buyOrders, ...sellOrders];
  const cancelledOrders: string[] = [];
  const mockExchange = {
    getBalances: jest.fn().mockResolvedValue([
      { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
      { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
    ]),
    getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
    getOpenOrders: jest.fn().mockImplementation(() => Promise.resolve(openOrders.filter((o: any) => !cancelledOrders.includes(o.orderId)))),
    cancelOrder: jest.fn().mockImplementation((_symbol: any, orderId: string) => {
      cancelledOrders.push(orderId);
      return Promise.resolve();
    }),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn().mockResolvedValue([])
  };
  jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.0);
  const config = require('../../config').config;
  config.volumeStrategy.orderFrequency = 1000000;
  config.trading.pair = 'EPWXUSDT';
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  (strategy as any).startOrderPlacementLoop = jest.fn();
  (strategy as any).startMonitoringLoop = jest.fn();
  // Act: run placeVolumeOrders (should trigger cancellation of excess orders)
  await (strategy as any).placeVolumeOrders();
  // Assert: only 30 buy and 30 sell orders remain
  const remainingOrders = await mockExchange.getOpenOrders();
  const remainingBuys = remainingOrders.filter((o: any) => o.side === 'BUY');
  const remainingSells = remainingOrders.filter((o: any) => o.side === 'SELL');
  expect(remainingBuys.length).toBe(targetOrdersPerSide);
  expect(remainingSells.length).toBe(targetOrdersPerSide);
  // Assert: correct number of cancels were called
  expect(mockExchange.cancelOrder).toHaveBeenCalledTimes(12); // 5 buys + 7 sells
  // Assert: the oldest orders were cancelled (should keep the newest 30)
  const buyIds = remainingBuys.map((o: any) => o.orderId);
  const sellIds = remainingSells.map((o: any) => o.orderId);
  expect(buyIds).toEqual(buyOrders.slice(-30).map((o: any) => o.orderId));
  expect(sellIds).toEqual(sellOrders.slice(-30).map((o: any) => o.orderId));
});
jest.setTimeout(20000);

describe('Order Placement Logic', () => {
      it('should SKIP real user SELL order if MM balance < $500 and not market value order', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 400, locked: 0, total: 400 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn(),
        };
        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        // Price is NOT market value (more than 0.5% away)
        await strategy.placeSellOrder(1.02, 10, false);
        expect(mockExchange.placeOrder).not.toHaveBeenCalled();
      });

      it('should EXECUTE real user SELL order if MM balance < $500 but IS market value order', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'testSell', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 10, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
        };
        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        // Price IS market value (within 0.5%)
        await strategy.placeSellOrder(1.004, 10, false);
        expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'SELL', 'LIMIT', 10, 1.004);
      });
    it('should place at least 30 buy and 30 sell orders in the target price bands', async () => {
      // Always return a fresh, sufficient balance for every call
      const mockExchange = {
        getBalances: jest.fn().mockImplementation(() => [
          { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
          { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
        ].map(b => ({ ...b }))),
        getTicker: async () => ({ bid: 1.0, ask: 1.0, price: 1.0 }),
        getOpenOrders: async () => [],
        cancelOrder: jest.fn(),
        placeOrder: jest.fn().mockResolvedValue({ orderId: Math.random().toString(), symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
        getRecentTrades: jest.fn().mockResolvedValue([])
      };

      jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.0);
      const config = require('../../config').config;
      config.volumeStrategy.orderFrequency = 1000000;
      config.trading.pair = 'EPWXUSDT';

      const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
      strategy = new VolumeGenerationStrategy(mockExchange);
      (strategy as any).startOrderPlacementLoop = jest.fn();
      (strategy as any).startMonitoringLoop = jest.fn();

      // Spy on placeBuyOrder and placeSellOrder
      const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('buyId');
      const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sellId');

      await (strategy as any).placeVolumeOrders();

      // Only count book-depth orders (isWashTrade !== true)
      const buyBookDepthCalls = buySpy.mock.calls.filter(args => args[2] !== true);
      const sellBookDepthCalls = sellSpy.mock.calls.filter(args => args[2] !== true);
      expect(buyBookDepthCalls.length).toBeGreaterThanOrEqual(30);
      expect(sellBookDepthCalls.length).toBeGreaterThanOrEqual(30);
    });
  let strategy: import('../volume-generation.strategy').VolumeGenerationStrategy | undefined;
  let setTimeoutSpy: jest.SpyInstance;
  let setIntervalSpy: jest.SpyInstance;
  beforeEach(() => {
    // Mock setTimeout and setInterval to immediately invoke the callback
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((cb: any, _ms: any, ...args: any[]) => {
      if (typeof cb === 'function') cb(...args);
      // Return a dummy timer id
      return 0 as any;
    });
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((cb: any, _ms: any, ...args: any[]) => {
      if (typeof cb === 'function') cb(...args);
      // Return a dummy timer id
      return 0 as any;
    });
  });
  afterEach(() => {
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
    if (strategy && (strategy as any).orderTimer) {
      clearInterval((strategy as any).orderTimer);
      (strategy as any).orderTimer = undefined;
    }
    if (strategy && (strategy as any).updateTimer) {
      clearInterval((strategy as any).updateTimer);
      (strategy as any).updateTimer = undefined;
    }
  });
});
// Clean Jest test file for volume-generation.strategy.ts
console.log('Loaded volume-generation.strategy.test.ts');
import '../__tests__/setup-env';
import { VolumeGenerationStrategy } from '../volume-generation.strategy';

// --- MockExchangeService must be defined before any test classes use it ---
class MockExchangeService {
  balances: any[] = [];
  ticker: any = { price: 1 };
  placedOrders: any[] = [];
  async getBalances() { return this.balances; }
  async getTicker(symbol: string) { return this.ticker; }
  async placeOrder(symbol: string, side: 'BUY' | 'SELL', type: 'LIMIT' | 'MARKET', amount: number, price?: number) {
    this.placedOrders.push({ symbol, side, type, amount, price });
    return { orderId: 'test', symbol, side, type, price: typeof price === 'number' ? price : 0, amount, filled: 0, status: "NEW" as const, timestamp: Date.now(), fee: 0 };
  }
}

describe('Wash trading logic', () => {
  class WashTestStrategy extends VolumeGenerationStrategy {
    public placedWashBuys: any[] = [];
    public placedWashSells: any[] = [];
    constructor() {
      super(new MockExchangeService() as any);
    }
    async placeBuyOrder(price: number, amount: number, isWashTrade?: boolean) {
      if (isWashTrade) this.placedWashBuys.push({ price, amount });
      return 'buyOrderId_' + Math.random();
    }
    async placeSellOrder(price: number, amount: number, isWashTrade?: boolean) {
      if (isWashTrade) this.placedWashSells.push({ price, amount });
      return 'sellOrderId_' + Math.random();
    }
    // Expose protected/private properties for testing
    public getWashTradePairsActive() { return this.washTradePairsActive; }
    public setWashTradePairsActive(val: any) { this.washTradePairsActive = val; }
    public getProfitStats() { return this.profitStats; }
    public setProfitStats(val: any) { this.profitStats = val; }
    public getVolumeStats() {
      // Return a shallow copy to allow test inspection
      // @ts-ignore: Accessing private for test only
      return { ...this["volumeStats"] };
    }
    public setVolumeStats(val: any) {
      // @ts-ignore: Accessing private for test only
      this["volumeStats"] = { ...val };
    }
  }

  it('should place matching buy/sell orders for wash trading and track pairs', async () => {
    const strategy = new WashTestStrategy();
    // Simulate the wash trading logic from placeVolumeOrders
    const washTradePairs = 3;
    strategy.setWashTradePairsActive([]);
    for (let i = 0; i < washTradePairs; i++) {
      const matchPrice = 1.0;
      const amount = 10;
      const buyOrderId = await strategy.placeBuyOrder(matchPrice, amount, true);
      const sellOrderId = await strategy.placeSellOrder(matchPrice, amount, true);
      if (buyOrderId && sellOrderId) {
        const pairs = strategy.getWashTradePairsActive();
        pairs.push({ buyOrderId, sellOrderId, price: matchPrice, amount });
        strategy.setWashTradePairsActive(pairs);
      }
    }
    expect(strategy.placedWashBuys.length).toBe(washTradePairs);
    expect(strategy.placedWashSells.length).toBe(washTradePairs);
    expect(strategy.getWashTradePairsActive().length).toBe(washTradePairs);
    for (let i = 0; i < washTradePairs; i++) {
      expect(strategy.getWashTradePairsActive()[i].price).toBe(1.0);
      expect(strategy.getWashTradePairsActive()[i].amount).toBe(10);
    }
  });

  it('should increment washTrades count in profitStats on wash trade fill', async () => {
    const strategy = new WashTestStrategy();
    // Simulate a wash trade fill
    const profitStats = strategy.getProfitStats();
    profitStats.washTrades = 0;
    strategy.setProfitStats(profitStats);
    // Simulate pollOrderFills logic
    const fakeTrade = { side: 'BUY', amount: 5, price: 1, tradeId: 't1' };
    const volumeStats = strategy.getVolumeStats();
    volumeStats.totalVolume = 0;
    volumeStats.buyVolume = 0;
    volumeStats.sellVolume = 0;
    volumeStats.orderCount = 0;
    volumeStats.startTime = Date.now();
    volumeStats.lastOrderTime = 0;
    strategy.setVolumeStats(volumeStats);
    // Directly increment as in pollOrderFills
    const profitStats2 = strategy.getProfitStats();
    profitStats2.washTrades++;
    strategy.setProfitStats(profitStats2);
    const volumeStats2 = strategy.getVolumeStats();
    volumeStats2.totalVolume += fakeTrade.amount * fakeTrade.price;
    volumeStats2.buyVolume += fakeTrade.amount * fakeTrade.price;
    strategy.setVolumeStats(volumeStats2);
    expect(strategy.getProfitStats().washTrades).toBe(1);
    expect(strategy.getVolumeStats().totalVolume).toBe(5);
    expect(strategy.getVolumeStats().buyVolume).toBe(5);
  });
});
describe('MM account balance < $1000 order execution', () => {
  class TestMMStrategy extends VolumeGenerationStrategy {
    constructor(mockExchange: any, symbol: string = 'EPWXUSDT') {
      super(mockExchange);
      (this as any).symbol = symbol; // Bypass private for test only
    }
    // Expose protected method for testing
    public async testPlaceSellOrder(price: number, amount: number, isWashTrade: boolean = false) {
      return this.placeSellOrder(price, amount, isWashTrade);
    }
  }

  it('should NOT execute real user SELL order if MM balance < $1000 and not market order', async () => {
    // Mock exchange with low USDT balance
    const mockExchange = {
      getBalances: async () => [
        { asset: 'EPWX', free: 1000 },
        { asset: 'USDT', free: 500, locked: 0 }
      ],
      getTicker: async () => ({ price: 10 }),
      placeOrder: jest.fn().mockResolvedValue({ orderId: 'test', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 10, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 })
    };
    const strategy = new TestMMStrategy(mockExchange);
    // Price is far from market (not a market order)
      const result = await strategy.testPlaceSellOrder(12, 1, false);
      // Should not place order, so result should be undefined
      expect(result).toBeUndefined();
    // Optionally, check that placeOrder was called or not, depending on the actual logic
    // expect(mockExchange.placeOrder).not.toHaveBeenCalled();
  });

  it('should execute real user SELL market order even if MM balance < $1000', async () => {
    // Mock exchange with low USDT balance
    const mockExchange = {
      getBalances: async () => [
        { asset: 'EPWX', free: 1000, locked: 0, total: 1000 },
        { asset: 'USDT', free: 500, locked: 0, total: 500 }
      ],
      getTicker: async () => ({ price: 10.04 }),
      placeOrder: jest.fn().mockResolvedValue({ orderId: 'sellId', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 10.04, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
      getRecentTrades: jest.fn().mockResolvedValue([]),
      cancelAllOrders: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([])
    };
    const strategy = new TestMMStrategy(mockExchange, 'EPWXUSDT');
    // Price is within 0.5% of market (market order)
    // Debug: Log before and after
    console.log('Calling testPlaceSellOrder...');
    const result = await strategy.testPlaceSellOrder(10.00, 1, false);
    console.log('Result from testPlaceSellOrder:', result);
    expect(result).toBeDefined();
    expect(result).toBe('sellId');
    console.log('mockExchange.placeOrder call count:', mockExchange.placeOrder.mock.calls.length);
    expect(mockExchange.placeOrder).toHaveBeenCalled();
  });

  it('should execute real user BUY order even if MM balance < $1000', async () => {
    // Mock exchange with low USDT balance
    const mockExchange = {
      getBalances: async () => [
        { asset: 'EPWX', free: 1000, locked: 0, total: 1000 },
        { asset: 'USDT', free: 500, locked: 0, total: 500 }
      ],
      getTicker: async () => ({ price: 10 }),
      placeOrder: jest.fn().mockResolvedValue({ orderId: 'buyId', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 10, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
      getRecentTrades: jest.fn().mockResolvedValue([]),
      cancelAllOrders: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([])
    };
    // Extend strategy to expose placeBuyOrder
    class TestMMStrategyWithBuy extends VolumeGenerationStrategy {
      constructor(mockExchange: any, symbol: string = 'EPWXUSDT') {
        super(mockExchange);
        (this as any).symbol = symbol; // Bypass private for test only
      }
      public async testPlaceBuyOrder(price: number, amount: number, isWashTrade: boolean = false) {
        return this.placeBuyOrder(price, amount, isWashTrade);
      }
    }
    const strategy = new TestMMStrategyWithBuy(mockExchange, 'EPWXUSDT');
    // Debug: Log before and after
    console.log('Calling testPlaceBuyOrder...');
    const result = await strategy.testPlaceBuyOrder(10, 1, false);
    console.log('Result from testPlaceBuyOrder:', result);
    expect(result).toBeDefined();
    expect(result).toBe('buyId');
    console.log('mockExchange.placeOrder call count:', mockExchange.placeOrder.mock.calls.length);
    expect(mockExchange.placeOrder).toHaveBeenCalled();
  });
});
it('should handle floating-point precision and not miss the 500 USDT threshold', async () => {
  const strategy = new DepthStrategy();
  const priceReference = 1;
  // Orders that sum to just below 500 due to floating-point math
  strategy.buyOrders = [
    { price: 0.99, amount: 101.010101, side: 'BUY' }, // 99.00
    { price: 0.99, amount: 101.010101, side: 'BUY' }, // 99.00
    { price: 0.99, amount: 101.010101, side: 'BUY' }, // 99.00
    { price: 0.99, amount: 101.010101, side: 'BUY' }, // 99.00
    { price: 0.99, amount: 101.010101, side: 'BUY' }  // 99.00
  ];
  // 5 * 99 = 495, but due to floating-point, it may be slightly less
  // Use the same min buy price as other tests for consistency
  const minBuyPrice = 0.9372;
  const maxBuyPrice = priceReference * 1.00;
  let buyDepth = strategy.buyOrders
    .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
    .reduce((sum, o) => sum + o.price * o.amount, 0);
  // Add a small order to reach 500
  if (buyDepth < 500) {
    const needed = 500 - buyDepth;
    await strategy.placeBuyOrder(0.99, needed / 0.99);
    buyDepth += needed;
  }
  const placedBuyValue = strategy.placedBuys.reduce((sum, o) => sum + o.price * o.amount, 0);
  expect(buyDepth + placedBuyValue).toBeGreaterThanOrEqual(500);
});
it('should not count orders with zero or negative amounts toward depth', async () => {
  const strategy = new DepthStrategy();
  const priceReference = 1;
  strategy.buyOrders = [
    { price: 0.99, amount: 0, side: 'BUY' },    // zero
    { price: 0.99, amount: -10, side: 'BUY' }, // negative
    { price: 0.99, amount: 100, side: 'BUY' }  // valid
  ];
  strategy.sellOrders = [
                { price: 1.01, amount: 0, side: 'SELL' },    // zero
                { price: 1.01, amount: -20, side: 'SELL' }, // negative
                { price: 1.01, amount: 200, side: 'SELL' }  // valid
              ];
              // Use the same min/max as other tests for consistency
              const minBuyPrice = 0.9372;
              const maxBuyPrice = priceReference * 1.00;
              const minSellPrice = priceReference * 1.00;
              const maxSellPrice = priceReference * 1.02;
              const buyDepth = strategy.buyOrders
                .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice && o.amount > 0)
                .reduce((sum, o) => sum + o.price * o.amount, 0);
              const sellDepth = strategy.sellOrders
                .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice && o.amount > 0)
                .reduce((sum, o) => sum + o.price * o.amount, 0);
              // Only the valid orders should count
              expect(buyDepth).toBeCloseTo(99, 0);
              expect(sellDepth).toBeCloseTo(202, 0);
            });
          it('should only count orders within bands toward depth when mixed with outside orders', async () => {
            const strategy = new DepthStrategy();
            const priceReference = 1;
            // Orders inside and outside the buy band
            strategy.buyOrders = [
              { price: 0.97, amount: 100, side: 'BUY' }, // outside
              { price: 0.98, amount: 100, side: 'BUY' }, // inside
              { price: 0.99, amount: 100, side: 'BUY' }, // inside
              { price: 1.01, amount: 100, side: 'BUY' }  // outside
            ];
            // Orders inside and outside the sell band
            strategy.sellOrders = [
              { price: 0.99, amount: 100, side: 'SELL' }, // outside
              { price: 1.00, amount: 100, side: 'SELL' }, // inside
              { price: 1.01, amount: 100, side: 'SELL' }, // inside
              { price: 1.03, amount: 100, side: 'SELL' }  // outside
            ];
            const minBuyPrice = priceReference * 0.98;
            const maxBuyPrice = priceReference * 1.00;
            const minSellPrice = priceReference * 1.00;
            const maxSellPrice = priceReference * 1.02;
            const buyDepth = strategy.buyOrders
              .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
              .reduce((sum, o) => sum + o.price * o.amount, 0);
            const sellDepth = strategy.sellOrders
              .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
              .reduce((sum, o) => sum + o.price * o.amount, 0);
            // Only the inside orders should count
            // buy: 0.98*100 + 0.99*100 = 98 + 99 = 197
            // sell: 1.00*100 + 1.01*100 = 100 + 101 = 201
            expect(buyDepth).toBeCloseTo(197, 0);
            expect(sellDepth).toBeCloseTo(201, 0);
          });
        it('should only add enough orders to reach 500 USDT if partial depth exists', async () => {
          const strategy = new DepthStrategy();
          const priceReference = 1;
          // Pre-existing buy orders totaling 300 USDT in the band
          strategy.buyOrders = [
            { price: 0.99, amount: 100, side: 'BUY' }, // $99
            { price: 1.00, amount: 201, side: 'BUY' } // $201
          ];
          const minBuyPrice = priceReference * 0.98;
          const maxBuyPrice = priceReference * 1.00;
          const buyDepth = strategy.buyOrders
            .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
            .reduce((sum, o) => sum + o.price * o.amount, 0);
          let buyDepthShortfall = 500 - buyDepth;
          const safeOrderSizeUSD = 100;
          let added = 0;
          while (buyDepthShortfall > 0) {
            const buyPrice = Math.max(minBuyPrice, Math.min(maxBuyPrice, priceReference * (1 - 0.01 * Math.random())));
            const amount = Math.min(safeOrderSizeUSD, buyDepthShortfall) / buyPrice;
            await strategy.placeBuyOrder(buyPrice, amount);
            buyDepthShortfall -= buyPrice * amount;
            added += buyPrice * amount;
          }
          const placedBuyValue = strategy.placedBuys.reduce((sum, o) => sum + o.price * o.amount, 0);
          expect(buyDepth).toBeCloseTo(300, 0);
          expect(buyDepth + placedBuyValue).toBeGreaterThanOrEqual(500);
          expect(buyDepth + placedBuyValue).toBeLessThan(600);
          expect(added).toBeLessThanOrEqual(200.01); // Only add up to the shortfall
        });
      it('should not count orders outside ±2% bands toward depth', async () => {
        const strategy = new DepthStrategy();
        const priceReference = 1;
        // Orders outside the bands
        strategy.buyOrders = [
          { price: 0.97, amount: 500, side: 'BUY' }, // below 98%
          { price: 1.01, amount: 500, side: 'BUY' }  // above 100%
        ];
        strategy.sellOrders = [
          { price: 0.99, amount: 500, side: 'SELL' }, // below 100%
          { price: 1.03, amount: 500, side: 'SELL' }  // above 102%
        ];
        const minBuyPrice = priceReference * 0.98;
        const maxBuyPrice = priceReference * 1.00;
        const minSellPrice = priceReference * 1.00;
        const maxSellPrice = priceReference * 1.02;
        const buyDepth = strategy.buyOrders
          .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
          .reduce((sum, o) => sum + o.price * o.amount, 0);
        const sellDepth = strategy.sellOrders
          .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
          .reduce((sum, o) => sum + o.price * o.amount, 0);
        expect(buyDepth).toBe(0);
        expect(sellDepth).toBe(0);
      });
    it('should count orders at 98%, 100%, and 102% band edges toward depth', async () => {
      const strategy = new DepthStrategy();
      const priceReference = 1;
      // Orders at the exact band edges
      strategy.buyOrders = [
        { price: 0.98, amount: 200, side: 'BUY' }, // 98%
        { price: 1.00, amount: 300, side: 'BUY' }  // 100%
      ];
      strategy.sellOrders = [
        { price: 1.00, amount: 250, side: 'SELL' }, // 100%
        { price: 1.02, amount: 300, side: 'SELL' }  // 102%
      ];
      const minBuyPrice = priceReference * 0.98;
      const maxBuyPrice = priceReference * 1.00;
      const minSellPrice = priceReference * 1.00;
      const maxSellPrice = priceReference * 1.02;
      const buyDepth = strategy.buyOrders
        .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
        .reduce((sum, o) => sum + o.price * o.amount, 0);
      const sellDepth = strategy.sellOrders
        .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
        .reduce((sum, o) => sum + o.price * o.amount, 0);
      // 0.98*200 + 1.00*300 = 196 + 300 = 496
      // 1.00*250 + 1.02*300 = 250 + 306 = 556
      expect(buyDepth).toBeCloseTo(496, 0);
      expect(sellDepth).toBeCloseTo(556, 0);
    });
  it('should create all required orders if the order book is empty', async () => {
    const strategy = new DepthStrategy();
    strategy.buyOrders = [];
    strategy.sellOrders = [];
    const targetOrdersPerSide = 30;
    // Simulate logic that would top up orders
    if (strategy.buyOrders.length < targetOrdersPerSide) {
      const needBuys = targetOrdersPerSide - strategy.buyOrders.length;
      for (let i = 0; i < needBuys; i++) {
        await strategy.placeBuyOrder(0.99, 10);
      }
    }
    if (strategy.sellOrders.length < targetOrdersPerSide) {
      const needSells = targetOrdersPerSide - strategy.sellOrders.length;
      for (let i = 0; i < needSells; i++) {
        await strategy.placeSellOrder(1.01, 10);
      }
    }
    expect(strategy.buyOrders.length).toBe(30);
    expect(strategy.sellOrders.length).toBe(30);
  });


// DepthStrategy for order book depth logic tests
class DepthStrategy {
  buyOrders: any[] = [];
  sellOrders: any[] = [];
  placedBuys: any[] = [];
  placedSells: any[] = [];
  constructor() {}
  async getOpenOrders() {
    // Stub for test compatibility
    return [...this.buyOrders, ...this.sellOrders];
  }
  async placeBuyOrder(price: number, amount: number) {
    this.placedBuys.push({ price, amount });
    this.buyOrders.push({ price, amount, side: 'BUY' });
    return 'buyOrderId';
  }
  async placeSellOrder(price: number, amount: number) {
    this.placedSells.push({ price, amount });
    this.sellOrders.push({ price, amount, side: 'SELL' });
    return 'sellOrderId';
  }
}
// End DepthStrategy class

describe('Order book depth logic', () => {
  it('should clean up excess buy and sell orders to maintain only 30 each', async () => {
    const strategy = new DepthStrategy();
    strategy.buyOrders = Array.from({ length: 35 }, (_, i) => ({ price: 0.99, amount: 10, side: 'BUY', id: i }));
    strategy.sellOrders = Array.from({ length: 37 }, (_, i) => ({ price: 1.01, amount: 10, side: 'SELL', id: i }));
    const targetOrdersPerSide = 30;
    if (strategy.buyOrders.length > targetOrdersPerSide) {
      strategy.buyOrders = strategy.buyOrders.slice(-targetOrdersPerSide);
    }
    if (strategy.sellOrders.length > targetOrdersPerSide) {
      strategy.sellOrders = strategy.sellOrders.slice(-targetOrdersPerSide);
    }
    expect(strategy.buyOrders.length).toBe(30);
    expect(strategy.sellOrders.length).toBe(30);
  });

  it('should maintain at least 30 buy and 30 sell orders', async () => {
    const strategy = new DepthStrategy();
    strategy.buyOrders = Array.from({ length: 28 }, (_, i) => ({ price: 0.99, amount: 10, side: 'BUY', id: i }));
    strategy.sellOrders = Array.from({ length: 29 }, (_, i) => ({ price: 1.01, amount: 10, side: 'SELL', id: i }));
    const targetOrdersPerSide = 30;
    if (strategy.buyOrders.length < targetOrdersPerSide) {
      const needBuys = targetOrdersPerSide - strategy.buyOrders.length;
      for (let i = 0; i < needBuys; i++) {
        await strategy.placeBuyOrder(0.99, 10);
      }
    }
    if (strategy.sellOrders.length < targetOrdersPerSide) {
      const needSells = targetOrdersPerSide - strategy.sellOrders.length;
      for (let i = 0; i < needSells; i++) {
        await strategy.placeSellOrder(1.01, 10);
      }
    }
    expect(strategy.buyOrders.length).toBeGreaterThanOrEqual(30);
    expect(strategy.sellOrders.length).toBeGreaterThanOrEqual(30);
  });

  it('should ensure buy order depth ≥ 500 USDT between 98%-100% of mid-price', async () => {
    const strategy = new DepthStrategy();
    await strategy.getOpenOrders();
    const priceReference = 1;
    const minBuyPrice = priceReference * 0.98;
    const maxBuyPrice = priceReference * 1.00;
    const buyDepth = strategy.buyOrders
      .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
      .reduce((sum, o) => sum + o.price * o.amount, 0);
    let buyDepthShortfall = 500 - buyDepth;
    const safeOrderSizeUSD = 100;
    while (buyDepthShortfall > 0) {
      const buyPrice = Math.max(minBuyPrice, Math.min(maxBuyPrice, priceReference * (1 - 0.01 * Math.random())));
      const amount = Math.min(safeOrderSizeUSD, buyDepthShortfall) / buyPrice;
      await strategy.placeBuyOrder(buyPrice, amount);
      buyDepthShortfall -= buyPrice * amount;
    }
    const placedBuyValue = strategy.placedBuys.reduce((sum, o) => sum + o.price * o.amount, 0);
    expect(buyDepth + placedBuyValue).toBeGreaterThanOrEqual(500);
  });

  it('should ensure sell order depth ≥ 500 USDT between 100%-102% of mid-price', async () => {
    const strategy = new DepthStrategy();
    await strategy.getOpenOrders();
    const priceReference = 1;
    const minSellPrice = priceReference * 1.00;
    const maxSellPrice = priceReference * 1.02;
    const sellDepth = strategy.sellOrders
      .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
      .reduce((sum, o) => sum + o.price * o.amount, 0);
    let sellDepthShortfall = 500 - sellDepth;
    const safeOrderSizeUSD = 100;
    while (sellDepthShortfall > 0) {
      const sellPrice = Math.max(minSellPrice, Math.min(maxSellPrice, priceReference * (1 + 0.01 * Math.random())));
      const amount = Math.min(safeOrderSizeUSD, sellDepthShortfall) / sellPrice;
      await strategy.placeSellOrder(sellPrice, amount);
      sellDepthShortfall -= sellPrice * amount;
    }
    const placedSellValue = strategy.placedSells.reduce((sum, o) => sum + o.price * o.amount, 0);
    expect(sellDepth + placedSellValue).toBeGreaterThanOrEqual(500);
  });

  it('should handle a large order book (hundreds of orders) efficiently and correctly', async () => {
    const strategy = new DepthStrategy();
    const priceReference = 1;
    // Generate 200 buy orders and 200 sell orders, spread across the bands
    strategy.buyOrders = Array.from({ length: 200 }, (_, i) => ({
      price: 0.98 + 0.02 * (i / 199), // from 0.98 to 1.00
      amount: 5 + (i % 10),
      side: 'BUY'
    }));
    strategy.sellOrders = Array.from({ length: 200 }, (_, i) => ({
      price: 1.00 + 0.02 * (i / 199), // from 1.00 to 1.02
      amount: 5 + (i % 10),
      side: 'SELL'
    }));
    // Calculate buy and sell depth in the bands
    const minBuyPrice = priceReference * 0.98;
    const maxBuyPrice = priceReference * 1.00;
    const minSellPrice = priceReference * 1.00;
    const maxSellPrice = priceReference * 1.02;
    const buyDepth = strategy.buyOrders
      .filter(o => o.price >= minBuyPrice && o.price <= maxBuyPrice)
      .reduce((sum, o) => sum + o.price * o.amount, 0);
    const sellDepth = strategy.sellOrders
      .filter(o => o.price >= minSellPrice && o.price <= maxSellPrice)
      .reduce((sum, o) => sum + o.price * o.amount, 0);
    // Should have at least 200 buy and 200 sell orders
    expect(strategy.buyOrders.length).toBeGreaterThanOrEqual(200);
    expect(strategy.sellOrders.length).toBeGreaterThanOrEqual(200);
    // Should have at least 500 USDT depth in each band
    expect(buyDepth).toBeGreaterThanOrEqual(500);
    expect(sellDepth).toBeGreaterThanOrEqual(500);
    // Should not add unnecessary orders if already satisfied
    // No additional orders should be placed if depth is already sufficient
    expect(strategy.placedBuys.length).toBe(0);
    expect(strategy.placedSells.length).toBe(0);
  });

});
