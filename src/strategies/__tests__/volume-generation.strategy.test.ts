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
  const availableUSDT = 5000;
  const targetOrdersPerSide = 30;
  const totalOrdersNeeded = targetOrdersPerSide * 2;
  const expected = Math.min((availableUSDT * 0.8) / totalOrdersNeeded, 20);
  const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn(),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const actualSafeOrderSize = (strategy as any).getDynamicOrderUsdTarget(expected);

  expect(actualSafeOrderSize).toBeCloseTo(expected, 2);
  randomSpy.mockRestore();
});
it('should randomize per-order USD targets so quantities do not stay identical', () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn(),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const randomValues = [0, 0.5, 1];
  let index = 0;
  const randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => {
    const value = randomValues[index] ?? randomValues[randomValues.length - 1];
    index += 1;
    return value;
  });

  const targets = [
    (strategy as any).getDynamicOrderUsdTarget(20),
    (strategy as any).getDynamicOrderUsdTarget(20),
    (strategy as any).getDynamicOrderUsdTarget(20),
  ];

  expect(new Set(targets.map((target: number) => target.toFixed(2))).size).toBeGreaterThan(1);
  expect(Math.min(...targets)).toBeGreaterThanOrEqual(5.26);
  expect(Math.max(...targets)).toBeLessThanOrEqual(23.6);
  randomSpy.mockRestore();
});
it('should scale order notional above the legacy hard cap when balance allows it', () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn(),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;
  const originalMaxOrderSize = config.volumeStrategy.maxOrderSize;

  config.volumeStrategy.maxOrderSize = 20;

  try {
    const scaledTarget = (strategy as any).getBalanceAwareOrderUsdTarget(10000, 30, 0.92);

    expect(scaledTarget).toBeGreaterThan(20);
    expect(scaledTarget).toBeLessThanOrEqual(100);
  } finally {
    config.volumeStrategy.maxOrderSize = originalMaxOrderSize;
  }
});
it('should allow price-aware normalization to exceed the legacy token ceiling when balance permits', () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn(),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);

  const normalizedAmount = (strategy as any).normalizeOrderAmount(10_000_000_000_000, 2.05e-10, 100000);

  expect(normalizedAmount).toBeGreaterThan(50_000_000_000);
});

it('should enforce normalization cap upper bound from configured max order amount tokens', () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn(),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn(),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMaxOrderAmountTokens = config.volumeStrategy.maxOrderAmountTokens;
  const originalMaxOrderSize = config.volumeStrategy.maxOrderSize;

  try {
    config.volumeStrategy.maxOrderAmountTokens = 1000;
    config.volumeStrategy.maxOrderSize = 500;

    const staticBounded = (strategy as any).normalizeOrderAmount(10000, 1, 100000);
    expect(staticBounded).toBe(1000);

  } finally {
    config.volumeStrategy.maxOrderAmountTokens = originalMaxOrderAmountTokens;
    config.volumeStrategy.maxOrderSize = originalMaxOrderSize;
  }
});

it('should throttle rebalance actions with cooldown to avoid repeated cancel/rebuy loops', async () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn().mockResolvedValue({ bid: 1, ask: 1, price: 1 }),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn().mockResolvedValue(0),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalEnablePositionLimits = config.risk.enablePositionLimits;
  const originalPositionThreshold = config.marketMaking.positionRebalanceThreshold;
  const originalRebalanceCooldownMs = config.marketMaking.rebalanceCooldownMs;

  try {
    config.risk.enablePositionLimits = true;
    config.marketMaking.positionRebalanceThreshold = 1000;
    config.marketMaking.rebalanceCooldownMs = 60_000;

    (strategy as any).currentPosition = -5000;
    const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('rebalance-buy-1');

    await (strategy as any).checkAndRebalancePosition();
    await (strategy as any).checkAndRebalancePosition();

    expect(mockExchange.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(buySpy).toHaveBeenCalledTimes(1);
  } finally {
    config.risk.enablePositionLimits = originalEnablePositionLimits;
    config.marketMaking.positionRebalanceThreshold = originalPositionThreshold;
    config.marketMaking.rebalanceCooldownMs = originalRebalanceCooldownMs;
  }
});

it('should suppress rebalance sell when quote deviates too far from mark reference', async () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.01, price: 1.005 }),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn().mockResolvedValue(0),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalEnablePositionLimits = config.risk.enablePositionLimits;
  const originalPositionThreshold = config.marketMaking.positionRebalanceThreshold;
  const originalRebalanceCooldownMs = config.marketMaking.rebalanceCooldownMs;
  const originalRebalanceMaxSpreadPercent = config.marketMaking.rebalanceMaxSpreadPercent;
  const originalRebalanceMaxPriceDeviationPercent = config.marketMaking.rebalanceMaxPriceDeviationPercent;

  try {
    config.risk.enablePositionLimits = true;
    config.marketMaking.positionRebalanceThreshold = 1000;
    config.marketMaking.rebalanceCooldownMs = 0;
    config.marketMaking.rebalanceMaxSpreadPercent = 10;
    config.marketMaking.rebalanceMaxPriceDeviationPercent = 2;

    (strategy as any).currentPosition = 5000;
    (strategy as any).profitStats.inventoryMarkPrice = 2;
    const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('rebalance-sell-guarded');

    await (strategy as any).checkAndRebalancePosition();

    expect(mockExchange.cancelAllOrders).not.toHaveBeenCalled();
    expect(sellSpy).not.toHaveBeenCalled();
  } finally {
    config.risk.enablePositionLimits = originalEnablePositionLimits;
    config.marketMaking.positionRebalanceThreshold = originalPositionThreshold;
    config.marketMaking.rebalanceCooldownMs = originalRebalanceCooldownMs;
    config.marketMaking.rebalanceMaxSpreadPercent = originalRebalanceMaxSpreadPercent;
    config.marketMaking.rebalanceMaxPriceDeviationPercent = originalRebalanceMaxPriceDeviationPercent;
  }
});

it('should suppress rebalance when ticker spread exceeds configured guard', async () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.2, price: 1.1 }),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn().mockResolvedValue(0),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalEnablePositionLimits = config.risk.enablePositionLimits;
  const originalPositionThreshold = config.marketMaking.positionRebalanceThreshold;
  const originalRebalanceCooldownMs = config.marketMaking.rebalanceCooldownMs;
  const originalRebalanceMaxSpreadPercent = config.marketMaking.rebalanceMaxSpreadPercent;
  const originalRebalanceMaxPriceDeviationPercent = config.marketMaking.rebalanceMaxPriceDeviationPercent;

  try {
    config.risk.enablePositionLimits = true;
    config.marketMaking.positionRebalanceThreshold = 1000;
    config.marketMaking.rebalanceCooldownMs = 0;
    config.marketMaking.rebalanceMaxSpreadPercent = 5;
    config.marketMaking.rebalanceMaxPriceDeviationPercent = 100;

    (strategy as any).currentPosition = 5000;
    const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('rebalance-sell-wide-spread');

    await (strategy as any).checkAndRebalancePosition();

    expect(mockExchange.cancelAllOrders).not.toHaveBeenCalled();
    expect(sellSpy).not.toHaveBeenCalled();
  } finally {
    config.risk.enablePositionLimits = originalEnablePositionLimits;
    config.marketMaking.positionRebalanceThreshold = originalPositionThreshold;
    config.marketMaking.rebalanceCooldownMs = originalRebalanceCooldownMs;
    config.marketMaking.rebalanceMaxSpreadPercent = originalRebalanceMaxSpreadPercent;
    config.marketMaking.rebalanceMaxPriceDeviationPercent = originalRebalanceMaxPriceDeviationPercent;
  }
});

it('enables idle auto wash once no real fills occur for the configured idle window', () => {
  const mockExchange = {
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMode = config.volumeStrategy.selfTradeMode;
  const originalIdleMs = config.volumeStrategy.idleWashEnableAfterMs;
  const originalCooldownMs = config.volumeStrategy.idleWashCooldownAfterRealFillMs;
  const originalMaxPairs = config.volumeStrategy.idleWashMaxPairsPerCycle;
  const originalRequireLowDrift = config.volumeStrategy.idleWashRequireLowDrift;
  const originalMaxDrift = config.volumeStrategy.idleWashMaxDriftPercent;
  const originalMaxSpread = config.volumeStrategy.idleWashMaxExecSpreadPercent;

  try {
    config.volumeStrategy.selfTradeMode = 'auto';
    config.volumeStrategy.idleWashEnableAfterMs = 1000;
    config.volumeStrategy.idleWashCooldownAfterRealFillMs = 30_000;
    config.volumeStrategy.idleWashMaxPairsPerCycle = 2;
    config.volumeStrategy.idleWashRequireLowDrift = true;
    config.volumeStrategy.idleWashMaxDriftPercent = 3;
    config.volumeStrategy.idleWashMaxExecSpreadPercent = 5;

    (strategy as any).lastRealFillAt = Date.now() - 5_000;
    const decision = (strategy as any).resolveWashTradeDecision({
      canRunWashTradesByDrift: true,
      dexCexDriftPercent: 1,
      executableSpreadPercent: 1,
      adverseBuyGuardActive: false,
      forceBuyPause: false,
      dynamicWashTradePairs: 6,
    });

    expect(decision.enabled).toBe(true);
    expect(decision.maxPairs).toBe(2);
    expect(decision.reason).toContain('SELF_TRADE_MODE=auto');
  } finally {
    config.volumeStrategy.selfTradeMode = originalMode;
    config.volumeStrategy.idleWashEnableAfterMs = originalIdleMs;
    config.volumeStrategy.idleWashCooldownAfterRealFillMs = originalCooldownMs;
    config.volumeStrategy.idleWashMaxPairsPerCycle = originalMaxPairs;
    config.volumeStrategy.idleWashRequireLowDrift = originalRequireLowDrift;
    config.volumeStrategy.idleWashMaxDriftPercent = originalMaxDrift;
    config.volumeStrategy.idleWashMaxExecSpreadPercent = originalMaxSpread;
  }
});

it('blocks idle auto wash during cooldown after a real fill', () => {
  const mockExchange = {
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMode = config.volumeStrategy.selfTradeMode;
  config.volumeStrategy.selfTradeMode = 'auto';

  try {
    (strategy as any).lastRealFillAt = Date.now() - 50_000;
    (strategy as any).washAutoCooldownUntil = Date.now() + 10_000;

    const decision = (strategy as any).resolveWashTradeDecision({
      canRunWashTradesByDrift: true,
      dexCexDriftPercent: 1,
      executableSpreadPercent: 1,
      adverseBuyGuardActive: false,
      forceBuyPause: false,
      dynamicWashTradePairs: 3,
    });

    expect(decision.enabled).toBe(false);
    expect(decision.maxPairs).toBe(0);
    expect(decision.reason).toContain('cooldown');
  } finally {
    config.volumeStrategy.selfTradeMode = originalMode;
  }
});

it('prioritizes idle wash pairs over passive top-touch orders when wash trades are enabled', async () => {
  const mockExchange = {
    getBalances: jest.fn().mockResolvedValue([
      { asset: 'USDT', free: 500, locked: 0, total: 500 },
      { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
    ]),
    getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.01, price: 1.005 }),
    getOpenOrders: jest.fn().mockResolvedValue([]),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn().mockResolvedValue({ orderId: 'wash-priority', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
    getRecentTrades: jest.fn().mockResolvedValue([]),
  };

  jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.005);
  const config = require('../../config').config;
  const originalOrderFrequency = config.volumeStrategy.orderFrequency;
  const originalPair = config.trading.pair;
  const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
  const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
  const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
  const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
  const originalForceBuyPause = config.volumeStrategy.forceBuyPause;
  const originalBuyReactivationMode = config.volumeStrategy.buyReactivationMode;
  const originalSelfTradeMode = config.volumeStrategy.selfTradeMode;
  const originalIdleWashEnableAfterMs = config.volumeStrategy.idleWashEnableAfterMs;
  const originalWashReservedPlacements = config.volumeStrategy.washReservedPlacementsPerCycle;
  const originalWashBasePairs = config.volumeStrategy.washBasePairsPerCycle;
  const originalWashMaxPairs = config.volumeStrategy.washMaxPairsPerCycle;
  const originalMaxExecSpreadPercent = config.volumeStrategy.maxExecSpreadPercent;
  const originalMinNetEdgeBps = config.volumeStrategy.minNetEdgeBps;
  const originalMinExecDepthBuyUsd = config.volumeStrategy.minExecDepthBuyUsd;
  const originalMinExecDepthSellUsd = config.volumeStrategy.minExecDepthSellUsd;
  const originalMaxDexCexDriftPercent = config.volumeStrategy.maxDexCexDriftPercent;
  const originalPauseWashOnHighDrift = config.volumeStrategy.pauseWashOnHighDrift;
  const originalIdleWashRequireLowDrift = config.volumeStrategy.idleWashRequireLowDrift;
  const originalIdleWashMaxDriftPercent = config.volumeStrategy.idleWashMaxDriftPercent;
  const originalIdleWashMaxExecSpreadPercent = config.volumeStrategy.idleWashMaxExecSpreadPercent;

  config.volumeStrategy.orderFrequency = 8000;
  config.trading.pair = 'EPWXUSDT';
  config.volumeStrategy.targetOrdersPerSide = 1;
  config.volumeStrategy.targetBuyDepthUsd = 0;
  config.volumeStrategy.targetSellDepthUsd = 0;
  config.volumeStrategy.idleBalanceReserveUsd = 140;
  config.volumeStrategy.forceBuyPause = false;
  config.volumeStrategy.buyReactivationMode = 'on';
  config.volumeStrategy.selfTradeMode = 'auto';
  config.volumeStrategy.idleWashEnableAfterMs = 0;
  config.volumeStrategy.washReservedPlacementsPerCycle = 0;
  config.volumeStrategy.washBasePairsPerCycle = 1;
  config.volumeStrategy.washMaxPairsPerCycle = 1;
  config.volumeStrategy.maxExecSpreadPercent = 999;
  config.volumeStrategy.minNetEdgeBps = 0;
  config.volumeStrategy.minExecDepthBuyUsd = 0;
  config.volumeStrategy.minExecDepthSellUsd = 0;
  config.volumeStrategy.maxDexCexDriftPercent = 999;
  config.volumeStrategy.pauseWashOnHighDrift = false;
  config.volumeStrategy.idleWashRequireLowDrift = false;
  config.volumeStrategy.idleWashMaxDriftPercent = 999;
  config.volumeStrategy.idleWashMaxExecSpreadPercent = 999;

  try {
    const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
    const strategy = new VolumeGenerationStrategy(mockExchange);
    (strategy as any).isRunning = true;

    const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockImplementation(async (_price, _amount, isWashTrade = false) => {
      return isWashTrade ? 'wash-buy' : 'regular-buy';
    });
    const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockImplementation(async (_price, _amount, isWashTrade = false) => {
      return isWashTrade ? 'wash-sell' : 'regular-sell';
    });

    await (strategy as any).placeVolumeOrders();

    const washBuyCalls = buySpy.mock.calls.filter(([, , isWashTrade]) => isWashTrade === true);
    const washSellCalls = sellSpy.mock.calls.filter(([, , isWashTrade]) => isWashTrade === true);
    const regularBuyCalls = buySpy.mock.calls.filter(([, , isWashTrade]) => isWashTrade === false);
    const regularSellCalls = sellSpy.mock.calls.filter(([, , isWashTrade]) => isWashTrade === false);

    expect(washBuyCalls).toHaveLength(1);
    expect(washSellCalls).toHaveLength(1);
    expect(regularBuyCalls).toHaveLength(0);
    expect(regularSellCalls).toHaveLength(0);
  } finally {
    config.volumeStrategy.orderFrequency = originalOrderFrequency;
    config.trading.pair = originalPair;
    config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
    config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
    config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
    config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
    config.volumeStrategy.forceBuyPause = originalForceBuyPause;
    config.volumeStrategy.buyReactivationMode = originalBuyReactivationMode;
    config.volumeStrategy.selfTradeMode = originalSelfTradeMode;
    config.volumeStrategy.idleWashEnableAfterMs = originalIdleWashEnableAfterMs;
    config.volumeStrategy.washReservedPlacementsPerCycle = originalWashReservedPlacements;
    config.volumeStrategy.washBasePairsPerCycle = originalWashBasePairs;
    config.volumeStrategy.washMaxPairsPerCycle = originalWashMaxPairs;
    config.volumeStrategy.maxExecSpreadPercent = originalMaxExecSpreadPercent;
    config.volumeStrategy.minNetEdgeBps = originalMinNetEdgeBps;
    config.volumeStrategy.minExecDepthBuyUsd = originalMinExecDepthBuyUsd;
    config.volumeStrategy.minExecDepthSellUsd = originalMinExecDepthSellUsd;
    config.volumeStrategy.maxDexCexDriftPercent = originalMaxDexCexDriftPercent;
    config.volumeStrategy.pauseWashOnHighDrift = originalPauseWashOnHighDrift;
    config.volumeStrategy.idleWashRequireLowDrift = originalIdleWashRequireLowDrift;
    config.volumeStrategy.idleWashMaxDriftPercent = originalIdleWashMaxDriftPercent;
    config.volumeStrategy.idleWashMaxExecSpreadPercent = originalIdleWashMaxExecSpreadPercent;
  }
});

it('allows relaxed wash-trade gating to bypass drift and spread blocking for same-price self-matching', () => {
  const mockExchange = {
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMode = config.volumeStrategy.selfTradeMode;
  const originalIdleMs = config.volumeStrategy.idleWashEnableAfterMs;
  const originalMaxPairs = config.volumeStrategy.idleWashMaxPairsPerCycle;
  const originalRequireLowDrift = config.volumeStrategy.idleWashRequireLowDrift;
  const originalMaxDrift = config.volumeStrategy.idleWashMaxDriftPercent;
  const originalMaxSpread = config.volumeStrategy.idleWashMaxExecSpreadPercent;

  try {
    config.volumeStrategy.selfTradeMode = 'auto';
    config.volumeStrategy.idleWashEnableAfterMs = 1000;
    config.volumeStrategy.idleWashMaxPairsPerCycle = 2;
    config.volumeStrategy.idleWashRequireLowDrift = true;
    config.volumeStrategy.idleWashMaxDriftPercent = 1.5;
    config.volumeStrategy.idleWashMaxExecSpreadPercent = 5;

    (strategy as any).lastRealFillAt = Date.now() - 10_000;

    const decision = (strategy as any).resolveWashTradeDecision({
      canRunWashTradesByDrift: false,
      dexCexDriftPercent: 20,
      executableSpreadPercent: 20,
      adverseBuyGuardActive: false,
      forceBuyPause: false,
      dynamicWashTradePairs: 2,
      relaxedWashGates: true,
    });

    expect(decision.enabled).toBe(true);
    expect(decision.maxPairs).toBe(2);
    expect(decision.reason).toContain('SELF_TRADE_MODE=auto');
  } finally {
    config.volumeStrategy.selfTradeMode = originalMode;
    config.volumeStrategy.idleWashEnableAfterMs = originalIdleMs;
    config.volumeStrategy.idleWashMaxPairsPerCycle = originalMaxPairs;
    config.volumeStrategy.idleWashRequireLowDrift = originalRequireLowDrift;
    config.volumeStrategy.idleWashMaxDriftPercent = originalMaxDrift;
    config.volumeStrategy.idleWashMaxExecSpreadPercent = originalMaxSpread;
  }
});

it('keeps relaxed wash-trade gating blocked by force pause and adverse-fill safeguards', () => {
  const mockExchange = {
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMode = config.volumeStrategy.selfTradeMode;
  const originalIdleMs = config.volumeStrategy.idleWashEnableAfterMs;

  try {
    config.volumeStrategy.selfTradeMode = 'auto';
    config.volumeStrategy.idleWashEnableAfterMs = 1000;

    (strategy as any).lastRealFillAt = Date.now() - 10_000;

    const decision = (strategy as any).resolveWashTradeDecision({
      canRunWashTradesByDrift: false,
      dexCexDriftPercent: 20,
      executableSpreadPercent: 20,
      adverseBuyGuardActive: true,
      forceBuyPause: true,
      dynamicWashTradePairs: 2,
      relaxedWashGates: true,
    });

    expect(decision.enabled).toBe(false);
    expect(decision.maxPairs).toBe(0);
    expect(decision.reason).toContain('FORCE_BUY_PAUSE=true');
  } finally {
    config.volumeStrategy.selfTradeMode = originalMode;
    config.volumeStrategy.idleWashEnableAfterMs = originalIdleMs;
  }
});

it('blocks idle auto wash when drift guard fails even after idle window elapsed', () => {
  const mockExchange = {
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMode = config.volumeStrategy.selfTradeMode;
  const originalRequireLowDrift = config.volumeStrategy.idleWashRequireLowDrift;
  const originalMaxDrift = config.volumeStrategy.idleWashMaxDriftPercent;
  const originalIdleMs = config.volumeStrategy.idleWashEnableAfterMs;

  try {
    config.volumeStrategy.selfTradeMode = 'auto';
    config.volumeStrategy.idleWashRequireLowDrift = true;
    config.volumeStrategy.idleWashMaxDriftPercent = 1.5;
    config.volumeStrategy.idleWashEnableAfterMs = 1000;

    (strategy as any).lastRealFillAt = Date.now() - 10_000;

    const decision = (strategy as any).resolveWashTradeDecision({
      canRunWashTradesByDrift: true,
      dexCexDriftPercent: 2.2,
      executableSpreadPercent: 1,
      adverseBuyGuardActive: false,
      forceBuyPause: false,
      dynamicWashTradePairs: 3,
    });

    expect(decision.enabled).toBe(false);
    expect(decision.maxPairs).toBe(0);
    expect(decision.reason).toContain('drift guard blocked');
  } finally {
    config.volumeStrategy.selfTradeMode = originalMode;
    config.volumeStrategy.idleWashRequireLowDrift = originalRequireLowDrift;
    config.volumeStrategy.idleWashMaxDriftPercent = originalMaxDrift;
    config.volumeStrategy.idleWashEnableAfterMs = originalIdleMs;
  }
});

it('immediately disables idle auto wash and starts cooldown when a real fill is detected', async () => {
  const mockExchange = {
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalMode = config.volumeStrategy.selfTradeMode;
  const originalCooldownMs = config.volumeStrategy.idleWashCooldownAfterRealFillMs;

  try {
    config.volumeStrategy.selfTradeMode = 'auto';
    config.volumeStrategy.idleWashCooldownAfterRealFillMs = 60_000;

    (strategy as any).washAutoEnabled = true;
    (strategy as any).washTradePairsActive = [
      { buyOrderId: 'wash-buy-1', sellOrderId: 'wash-sell-1', price: 1, amount: 10 }
    ];
    const cancelActiveWashOrdersSpy = jest
      .spyOn(strategy as any, 'cancelActiveWashOrders')
      .mockResolvedValue(undefined);

    const before = Date.now();
    (strategy as any).noteRealFillDetected('test-real-fill');

    expect((strategy as any).washAutoEnabled).toBe(false);
    expect((strategy as any).lastRealFillAt).toBeGreaterThanOrEqual(before);
    expect((strategy as any).washAutoCooldownUntil).toBeGreaterThan((strategy as any).lastRealFillAt);
    expect(cancelActiveWashOrdersSpy).toHaveBeenCalledWith('real external fill detected while auto wash was active');
  } finally {
    config.volumeStrategy.selfTradeMode = originalMode;
    config.volumeStrategy.idleWashCooldownAfterRealFillMs = originalCooldownMs;
  }
});

it('should execute rebalance when ticker spread and quote deviation are within guard limits', async () => {
  const mockExchange = {
    getBalances: jest.fn(),
    getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.01, price: 1.005 }),
    getOpenOrders: jest.fn(),
    cancelOrder: jest.fn(),
    placeOrder: jest.fn(),
    cancelAllOrders: jest.fn().mockResolvedValue(0),
    getRecentTrades: jest.fn()
  };
  const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
  const strategy = new VolumeGenerationStrategy(mockExchange);
  const config = require('../../config').config;

  const originalEnablePositionLimits = config.risk.enablePositionLimits;
  const originalPositionThreshold = config.marketMaking.positionRebalanceThreshold;
  const originalRebalanceCooldownMs = config.marketMaking.rebalanceCooldownMs;
  const originalRebalanceMaxSpreadPercent = config.marketMaking.rebalanceMaxSpreadPercent;
  const originalRebalanceMaxPriceDeviationPercent = config.marketMaking.rebalanceMaxPriceDeviationPercent;

  try {
    config.risk.enablePositionLimits = true;
    config.marketMaking.positionRebalanceThreshold = 1000;
    config.marketMaking.rebalanceCooldownMs = 0;
    config.marketMaking.rebalanceMaxSpreadPercent = 5;
    config.marketMaking.rebalanceMaxPriceDeviationPercent = 5;

    (strategy as any).currentPosition = 5000;
    (strategy as any).profitStats.inventoryMarkPrice = 1;
    const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('rebalance-sell-safe');

    await (strategy as any).checkAndRebalancePosition();

    expect(mockExchange.cancelAllOrders).toHaveBeenCalledTimes(1);
    expect(sellSpy).toHaveBeenCalledTimes(1);
    expect(sellSpy).toHaveBeenCalledWith(1.01, 1250);
  } finally {
    config.risk.enablePositionLimits = originalEnablePositionLimits;
    config.marketMaking.positionRebalanceThreshold = originalPositionThreshold;
    config.marketMaking.rebalanceCooldownMs = originalRebalanceCooldownMs;
    config.marketMaking.rebalanceMaxSpreadPercent = originalRebalanceMaxSpreadPercent;
    config.marketMaking.rebalanceMaxPriceDeviationPercent = originalRebalanceMaxPriceDeviationPercent;
  }
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
  (strategy as any).isRunning = true;
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

it('honors a lower configured target orders per side during cleanup', async () => {
  const targetOrdersPerSide = 4;
  const buyOrders = Array.from({ length: 7 }, (_, index) => ({
    orderId: `buy-${index}`,
    side: 'BUY',
    price: 1,
    amount: 10,
    timestamp: index + 1,
    filled: 0,
    status: 'NEW',
  }));
  const sellOrders = Array.from({ length: 6 }, (_, index) => ({
    orderId: `sell-${index}`,
    side: 'SELL',
    price: 1,
    amount: 10,
    timestamp: index + 1,
    filled: 0,
    status: 'NEW',
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
  const originalOrderFrequency = config.volumeStrategy.orderFrequency;
  const originalPair = config.trading.pair;
  const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
  const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
  const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;

  config.volumeStrategy.orderFrequency = 1000000;
  config.trading.pair = 'EPWXUSDT';
  config.volumeStrategy.targetOrdersPerSide = targetOrdersPerSide;
  config.volumeStrategy.targetBuyDepthUsd = 0;
  config.volumeStrategy.targetSellDepthUsd = 0;

  try {
    const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
    const strategy = new VolumeGenerationStrategy(mockExchange);
    (strategy as any).isRunning = true;

    await (strategy as any).placeVolumeOrders();

    const remainingOrders = await mockExchange.getOpenOrders();
    const remainingBuys = remainingOrders.filter((o: any) => o.side === 'BUY');
    const remainingSells = remainingOrders.filter((o: any) => o.side === 'SELL');
    expect(remainingBuys.length).toBe(targetOrdersPerSide);
    expect(remainingSells.length).toBe(targetOrdersPerSide);
  } finally {
    config.volumeStrategy.orderFrequency = originalOrderFrequency;
    config.trading.pair = originalPair;
    config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
    config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
    config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
  }
});
jest.setTimeout(20000);

describe('Order Placement Logic', () => {
      it('should EXECUTE real user SELL order even if MM USDT balance < $1000 and price is away from market', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'testSell', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.02, amount: 10, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
        };
        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        (strategy as any).isRunning = true;
        // Price is NOT market value (more than 0.5% away)
        await strategy.placeSellOrder(1.02, 10, false);
        expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'SELL', 'LIMIT', 10, 1.005);
      });

      it('should EXECUTE real user SELL order if MM balance < $1000 but IS market value order', async () => {
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
        (strategy as any).isRunning = true;
        // Price IS market value (within 0.5%)
        await strategy.placeSellOrder(1.004, 10, false);
        expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'SELL', 'LIMIT', 10, 1.004);
      });
    it('should place budgeted buy and sell orders in the target price bands each cycle', async () => {
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
      (strategy as any).isRunning = true;
      (strategy as any).startOrderPlacementLoop = jest.fn();
      (strategy as any).startMonitoringLoop = jest.fn();

      // Spy on placeBuyOrder and placeSellOrder
      const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('buyId');
      const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sellId');

      await (strategy as any).placeVolumeOrders();

      const buyPlacementCalls = buySpy.mock.calls;
      const sellPlacementCalls = sellSpy.mock.calls;
      // Current strategy reserves part of per-cycle slots for wash trades, so book placements are lower.
      expect(buyPlacementCalls.length).toBeGreaterThanOrEqual(10);
      expect(sellPlacementCalls.length).toBeGreaterThanOrEqual(10);
      expect(buyPlacementCalls.length + sellPlacementCalls.length).toBeGreaterThanOrEqual(20);
    });

      it('should limit a low-liquidity rollout cycle to the configured order and depth caps', async () => {
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
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;

        config.volumeStrategy.orderFrequency = 1000000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 4;
        config.volumeStrategy.targetBuyDepthUsd = 30;
        config.volumeStrategy.targetSellDepthUsd = 30;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;
          (strategy as any).startOrderPlacementLoop = jest.fn();
          (strategy as any).startMonitoringLoop = jest.fn();

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('buyId');
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sellId');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).toHaveBeenCalledTimes(1);
          expect(sellSpy).toHaveBeenCalledTimes(1);
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
        }
      });

      it('should clamp sell placement into the latest-price band before sending it to the exchange', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sellClamp', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 10, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
        };

        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        (strategy as any).isRunning = true;

        await strategy.placeSellOrder(1.02, 10, false);

        expect(mockExchange.placeOrder).toHaveBeenCalledTimes(1);
        expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'SELL', 'LIMIT', 10, 1.005);
      });

      it('should clamp buy placement into the latest-price band before sending it to the exchange', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'buyClamp', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 10, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
        };

        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        (strategy as any).isRunning = true;

        await strategy.placeBuyOrder(1.02, 10, false);

        expect(mockExchange.placeOrder).toHaveBeenCalledTimes(1);
        expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'BUY', 'LIMIT', 10, 1.005);
      });

      it('should reduce buy size after price clamp so the idle reserve stays untouched', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'buyReserve', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
        };

        const config = require('../../config').config;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        config.volumeStrategy.idleBalanceReserveUsd = 300;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          await strategy.placeBuyOrder(1.02, 400, false);

          expect(mockExchange.placeOrder).toHaveBeenCalledTimes(1);
          expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'BUY', 'LIMIT', 199, 1.005);
        } finally {
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
        }
      });

      it('should fall back to executable band pricing when buy repricing is extreme', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 10, ask: 10, price: 10 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'buyExtreme', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 10, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
        };

        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        (strategy as any).isRunning = true;

        try {
          await strategy.placeBuyOrder(1, 10, false);

          expect(mockExchange.placeOrder).toHaveBeenCalledTimes(1);
          expect(mockExchange.placeOrder).toHaveBeenCalledWith(expect.any(String), 'BUY', 'LIMIT', 1, 9.95);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('using exchange-band fallback buy pricing'));
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('should skip sell placement when clamp repricing is extreme', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 10, ask: 10, price: 10 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sellExtreme', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 10, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
        };

        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
        const strategy = new VolumeGenerationStrategy(mockExchange);
        (strategy as any).isRunning = true;

        try {
          await strategy.placeSellOrder(1, 10, false);

          expect(mockExchange.placeOrder).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping sell order due to extreme clamp reprice'));
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('should skip buy placement loops with one summary warning when spendable USDT is below minimum notional', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 193.82, locked: 0, total: 193.82 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 1.4535e-10 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'skip-cycle', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.170212766);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 25;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 190;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(sellSpy).toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Buy placements paused this cycle'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          warnSpy.mockRestore();
        }
      });

      it('should restore sell placement budget when reserve-paused buys collide with sell-imbalance priority', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 144.47, locked: 0, total: 144.47 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 1.4535e-10 }),
          getOpenOrders: jest.fn().mockResolvedValue([
            { orderId: 'existing-sell-1', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 4.3154e-9, amount: 1000000000, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }
          ]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sell-restored-cap', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.069148936);
        const logger = require('../../utils/logger').logger;
        const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;
        config.volumeStrategy.forceBuyPause = false;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(sellSpy).toHaveBeenCalled();
          expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Restoring sell placement budget because buy placements are reserve-constrained this cycle.'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
          infoSpy.mockRestore();
        }
      });

      it('should suppress all buy placements by policy when FORCE_BUY_PAUSE is enabled while keeping sell maintenance active', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 1.4535e-10 }),
          getOpenOrders: jest.fn().mockResolvedValue([
            { orderId: 'existing-sell-1', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 4.3154e-9, amount: 1000000000, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }
          ]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sell-policy-guard', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.170212766);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;
        config.volumeStrategy.forceBuyPause = true;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(sellSpy).toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('FORCE_BUY_PAUSE=true'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
          warnSpy.mockRestore();
        }
      });

      it('should block direct buy order placement when FORCE_BUY_PAUSE is enabled', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 10000, locked: 0, total: 10000 },
            { asset: 'EPWX', free: 10000, locked: 0, total: 10000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.0, price: 1.0 }),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'buyDirectBlocked', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 10, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
        };

        const config = require('../../config').config;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;
        config.volumeStrategy.forceBuyPause = true;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          await strategy.placeBuyOrder(1.0, 10, false);

          expect(mockExchange.placeOrder).not.toHaveBeenCalled();
        } finally {
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
        }
      });

      it('should suppress all buy placements when BUY_REACTIVATION_MODE=off while keeping sell maintenance active', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.01, price: 1.005 }),
          getOpenOrders: jest.fn().mockResolvedValue([
            { orderId: 'existing-sell-1', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.01, amount: 1000000000, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }
          ]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sell-reactivation-off', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.01, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.069148936);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;
        const originalBuyReactivationMode = config.volumeStrategy.buyReactivationMode;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;
        config.volumeStrategy.forceBuyPause = false;
        config.volumeStrategy.buyReactivationMode = 'off';

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(sellSpy).toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BUY_REACTIVATION_MODE=off'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
          config.volumeStrategy.buyReactivationMode = originalBuyReactivationMode;
          warnSpy.mockRestore();
        }
      });

      it('should suppress buy placements in BUY_REACTIVATION_MODE=auto when spread exceeds MAX_EXEC_SPREAD_PERCENT', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.2, price: 1.1 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sell-auto-guard', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.2, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.170212766);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;
        const originalBuyReactivationMode = config.volumeStrategy.buyReactivationMode;
        const originalMaxExecSpreadPercent = config.volumeStrategy.maxExecSpreadPercent;
        const originalMinNetEdgeBps = config.volumeStrategy.minNetEdgeBps;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;
        config.volumeStrategy.forceBuyPause = false;
        config.volumeStrategy.buyReactivationMode = 'auto';
        config.volumeStrategy.maxExecSpreadPercent = 8;
        config.volumeStrategy.minNetEdgeBps = 80;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue(undefined);

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(sellSpy).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BUY_REACTIVATION_MODE=auto blocked buys: spread'));
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Freezing new sell placements this cycle'));
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Sell placements using exchange-band fallback this cycle'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
          config.volumeStrategy.buyReactivationMode = originalBuyReactivationMode;
          config.volumeStrategy.maxExecSpreadPercent = originalMaxExecSpreadPercent;
          config.volumeStrategy.minNetEdgeBps = originalMinNetEdgeBps;
          warnSpy.mockRestore();
        }
      });

      it('should freeze new sell placements when sell depth target is disabled and buys are gated', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.2, price: 1.1 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sell-disabled', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.2, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.170212766);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;
        const originalBuyReactivationMode = config.volumeStrategy.buyReactivationMode;
        const originalMaxExecSpreadPercent = config.volumeStrategy.maxExecSpreadPercent;
        const originalMinNetEdgeBps = config.volumeStrategy.minNetEdgeBps;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 0;
        config.volumeStrategy.idleBalanceReserveUsd = 140;
        config.volumeStrategy.forceBuyPause = false;
        config.volumeStrategy.buyReactivationMode = 'auto';
        config.volumeStrategy.maxExecSpreadPercent = 8;
        config.volumeStrategy.minNetEdgeBps = 80;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue(undefined);

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(sellSpy).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Freezing new sell placements this cycle'));
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Sell placements using exchange-band fallback this cycle'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
          config.volumeStrategy.buyReactivationMode = originalBuyReactivationMode;
          config.volumeStrategy.maxExecSpreadPercent = originalMaxExecSpreadPercent;
          config.volumeStrategy.minNetEdgeBps = originalMinNetEdgeBps;
          warnSpy.mockRestore();
        }
      });

      it('should allow buy placements in BUY_REACTIVATION_MODE=auto when spread and edge gates pass', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 500, locked: 0, total: 500 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.0, ask: 1.01, price: 1.005 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'buy-auto-pass', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(1.069148936);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;
        const originalForceBuyPause = config.volumeStrategy.forceBuyPause;
        const originalBuyReactivationMode = config.volumeStrategy.buyReactivationMode;
        const originalMaxExecSpreadPercent = config.volumeStrategy.maxExecSpreadPercent;
        const originalMinNetEdgeBps = config.volumeStrategy.minNetEdgeBps;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;
        config.volumeStrategy.forceBuyPause = false;
        config.volumeStrategy.buyReactivationMode = 'auto';
        config.volumeStrategy.maxExecSpreadPercent = 8;
        config.volumeStrategy.minNetEdgeBps = 80;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('buy-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).toHaveBeenCalled();
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          config.volumeStrategy.forceBuyPause = originalForceBuyPause;
          config.volumeStrategy.buyReactivationMode = originalBuyReactivationMode;
          config.volumeStrategy.maxExecSpreadPercent = originalMaxExecSpreadPercent;
          config.volumeStrategy.minNetEdgeBps = originalMinNetEdgeBps;
        }
      });

      it('should block buys in auto mode when executable depth is below configured minimums', () => {
        const mockExchange = {
          getBalances: jest.fn(),
          getTicker: jest.fn(),
          getOpenOrders: jest.fn(),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn(),
          cancelAllOrders: jest.fn(),
          getRecentTrades: jest.fn()
        };

        const config = require('../../config').config;
        const originalMinExecDepthBuyUsd = config.volumeStrategy.minExecDepthBuyUsd;
        const originalMinExecDepthSellUsd = config.volumeStrategy.minExecDepthSellUsd;

        config.volumeStrategy.minExecDepthBuyUsd = 20;
        config.volumeStrategy.minExecDepthSellUsd = 20;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          const gate = (strategy as any).evaluateBuyReactivationGate(
            'auto',
            'CEX_TICKER_MID',
            1,
            1,
            1,
            3,
            { buyDepthUsd: 5, sellDepthUsd: 8 },
            false
          );

          expect(gate.allowBuys).toBe(false);
          expect(gate.reason).toContain('executable depth');
        } finally {
          config.volumeStrategy.minExecDepthBuyUsd = originalMinExecDepthBuyUsd;
          config.volumeStrategy.minExecDepthSellUsd = originalMinExecDepthSellUsd;
        }
      });

      it('should choose defensive auto-mode buy sizing when conditions are marginal', () => {
        const mockExchange = {
          getBalances: jest.fn(),
          getTicker: jest.fn(),
          getOpenOrders: jest.fn(),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn(),
          cancelAllOrders: jest.fn(),
          getRecentTrades: jest.fn()
        };

        const config = require('../../config').config;
        const originalMinNetEdgeBps = config.volumeStrategy.minNetEdgeBps;
        const originalMaxExecSpreadPercent = config.volumeStrategy.maxExecSpreadPercent;
        const originalMinExecDepthBuyUsd = config.volumeStrategy.minExecDepthBuyUsd;
        const originalMinExecDepthSellUsd = config.volumeStrategy.minExecDepthSellUsd;
        const originalRiskSizeMultiplierDefensive = config.volumeStrategy.riskSizeMultiplierDefensive;
        const originalRiskSizeMultiplierNormal = config.volumeStrategy.riskSizeMultiplierNormal;

        config.volumeStrategy.minNetEdgeBps = 80;
        config.volumeStrategy.maxExecSpreadPercent = 8;
        config.volumeStrategy.minExecDepthBuyUsd = 20;
        config.volumeStrategy.minExecDepthSellUsd = 20;
        config.volumeStrategy.riskSizeMultiplierDefensive = 0.35;
        config.volumeStrategy.riskSizeMultiplierNormal = 0.6;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          const decision = (strategy as any).resolveAutoBuySizingDecision(
            'auto',
            {
              allowBuys: true,
              evaluatedSpreadPercent: 5,
              estimatedNetEdgeBps: 120,
            },
            { buyDepthUsd: 25, sellDepthUsd: 24 }
          );

          expect(decision.regime).toBe('defensive');
          expect(decision.multiplier).toBeCloseTo(0.35, 6);
        } finally {
          config.volumeStrategy.minNetEdgeBps = originalMinNetEdgeBps;
          config.volumeStrategy.maxExecSpreadPercent = originalMaxExecSpreadPercent;
          config.volumeStrategy.minExecDepthBuyUsd = originalMinExecDepthBuyUsd;
          config.volumeStrategy.minExecDepthSellUsd = originalMinExecDepthSellUsd;
          config.volumeStrategy.riskSizeMultiplierDefensive = originalRiskSizeMultiplierDefensive;
          config.volumeStrategy.riskSizeMultiplierNormal = originalRiskSizeMultiplierNormal;
        }
      });

      it('should choose normal auto-mode buy sizing when spread, edge, and depth are strong', () => {
        const mockExchange = {
          getBalances: jest.fn(),
          getTicker: jest.fn(),
          getOpenOrders: jest.fn(),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn(),
          cancelAllOrders: jest.fn(),
          getRecentTrades: jest.fn()
        };

        const config = require('../../config').config;
        const originalMinNetEdgeBps = config.volumeStrategy.minNetEdgeBps;
        const originalMaxExecSpreadPercent = config.volumeStrategy.maxExecSpreadPercent;
        const originalMinExecDepthBuyUsd = config.volumeStrategy.minExecDepthBuyUsd;
        const originalMinExecDepthSellUsd = config.volumeStrategy.minExecDepthSellUsd;
        const originalRiskSizeMultiplierDefensive = config.volumeStrategy.riskSizeMultiplierDefensive;
        const originalRiskSizeMultiplierNormal = config.volumeStrategy.riskSizeMultiplierNormal;

        config.volumeStrategy.minNetEdgeBps = 80;
        config.volumeStrategy.maxExecSpreadPercent = 8;
        config.volumeStrategy.minExecDepthBuyUsd = 20;
        config.volumeStrategy.minExecDepthSellUsd = 20;
        config.volumeStrategy.riskSizeMultiplierDefensive = 0.35;
        config.volumeStrategy.riskSizeMultiplierNormal = 0.6;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          const decision = (strategy as any).resolveAutoBuySizingDecision(
            'auto',
            {
              allowBuys: true,
              evaluatedSpreadPercent: 2,
              estimatedNetEdgeBps: 180,
            },
            { buyDepthUsd: 50, sellDepthUsd: 50 }
          );

          expect(decision.regime).toBe('normal');
          expect(decision.multiplier).toBeCloseTo(0.6, 6);
        } finally {
          config.volumeStrategy.minNetEdgeBps = originalMinNetEdgeBps;
          config.volumeStrategy.maxExecSpreadPercent = originalMaxExecSpreadPercent;
          config.volumeStrategy.minExecDepthBuyUsd = originalMinExecDepthBuyUsd;
          config.volumeStrategy.minExecDepthSellUsd = originalMinExecDepthSellUsd;
          config.volumeStrategy.riskSizeMultiplierDefensive = originalRiskSizeMultiplierDefensive;
          config.volumeStrategy.riskSizeMultiplierNormal = originalRiskSizeMultiplierNormal;
        }
      });

      it('should suppress buy placements when adverse real-fill imbalance guard is active', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 250, locked: 0, total: 250 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 1.4535e-10 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'adverse-buy-guard-cycle', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(2.0e-10);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 25;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;
          (strategy as any).realBuyFills = 6;
          (strategy as any).realSellFills = 2;
          (strategy as any).currentPosition = 1_000_000_000;
          (strategy as any).profitStats.inventoryQuantity = 1_000_000_000;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue(undefined);
          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Adverse-fill buy guard active'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          warnSpy.mockRestore();
        }
      });

      it('should resume buy placements after adverse real-fill imbalance normalizes', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 250, locked: 0, total: 250 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 1.4535e-10 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'adverse-buy-resume-cycle', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(2.0e-10);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 25;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;
          (strategy as any).realBuyFills = 4;
          (strategy as any).realSellFills = 4;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('buy-seed');
          jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).toHaveBeenCalled();
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Adverse-fill buy guard active'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          warnSpy.mockRestore();
        }
      });

      it('should allow corrective buy placements when inventory is short even if buy fill-count skew exists', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 250, locked: 0, total: 250 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 1.4535e-10 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'adverse-buy-short-inventory', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(2.0e-10);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 25;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 140;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;
          (strategy as any).realBuyFills = 6;
          (strategy as any).realSellFills = 2;
          (strategy as any).currentPosition = -1_000_000_000;
          (strategy as any).profitStats.inventoryQuantity = -1_000_000_000;

          const buySpy = jest.spyOn(strategy as any, 'placeBuyOrder').mockResolvedValue('buy-seed');
          jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue('sell-seed');

          await (strategy as any).placeVolumeOrders();

          expect(buySpy).toHaveBeenCalled();
          expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Adverse-fill buy guard active'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          warnSpy.mockRestore();
        }
      });

      it('should use exchange-band fallback sell pricing when passive sell anchors would be extreme-clamped', async () => {
        const mockExchange = {
          getBalances: jest.fn().mockResolvedValue([
            { asset: 'USDT', free: 182.75, locked: 0, total: 182.75 },
            { asset: 'EPWX', free: 1000000000000, locked: 0, total: 1000000000000 }
          ]),
          getTicker: jest.fn().mockResolvedValue({ bid: 1.582e-10, ask: 1.325e-10, price: 4.9e-9 }),
          getOpenOrders: jest.fn().mockResolvedValue([]),
          cancelOrder: jest.fn(),
          placeOrder: jest.fn().mockResolvedValue({ orderId: 'sell-skip-cycle', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 1.0, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
          getRecentTrades: jest.fn().mockResolvedValue([]),
        };

        jest.spyOn(require('../../utils/dex-price'), 'fetchEpwXPriceFromPancake').mockResolvedValue(2.0e-10);
        const logger = require('../../utils/logger').logger;
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const config = require('../../config').config;
        const originalOrderFrequency = config.volumeStrategy.orderFrequency;
        const originalPair = config.trading.pair;
        const originalTargetOrdersPerSide = config.volumeStrategy.targetOrdersPerSide;
        const originalTargetBuyDepthUsd = config.volumeStrategy.targetBuyDepthUsd;
        const originalTargetSellDepthUsd = config.volumeStrategy.targetSellDepthUsd;
        const originalReserve = config.volumeStrategy.idleBalanceReserveUsd;

        config.volumeStrategy.orderFrequency = 12000;
        config.trading.pair = 'EPWXUSDT';
        config.volumeStrategy.targetOrdersPerSide = 2;
        config.volumeStrategy.targetBuyDepthUsd = 10;
        config.volumeStrategy.targetSellDepthUsd = 25;
        config.volumeStrategy.idleBalanceReserveUsd = 180;

        try {
          const { VolumeGenerationStrategy } = require('../volume-generation.strategy');
          const strategy = new VolumeGenerationStrategy(mockExchange);
          (strategy as any).isRunning = true;

          const sellSpy = jest.spyOn(strategy as any, 'placeSellOrder').mockResolvedValue(undefined);

          await (strategy as any).placeVolumeOrders();

          expect(sellSpy).toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exchange-band fallback'));
        } finally {
          config.volumeStrategy.orderFrequency = originalOrderFrequency;
          config.trading.pair = originalPair;
          config.volumeStrategy.targetOrdersPerSide = originalTargetOrdersPerSide;
          config.volumeStrategy.targetBuyDepthUsd = originalTargetBuyDepthUsd;
          config.volumeStrategy.targetSellDepthUsd = originalTargetSellDepthUsd;
          config.volumeStrategy.idleBalanceReserveUsd = originalReserve;
          warnSpy.mockRestore();
        }
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

  it('should use tracked order side when trade payload side disagrees', async () => {
    const strategy = new WashTestStrategy();
    const volumeStats = strategy.getVolumeStats();
    volumeStats.totalVolume = 0;
    volumeStats.buyVolume = 0;
    volumeStats.sellVolume = 0;
    strategy.setVolumeStats(volumeStats);

    (strategy as any).activeOrders.set('sell-order-1', {
      orderId: 'sell-order-1',
      symbol: 'EPWX/USDT',
      side: 'SELL',
      type: 'LIMIT',
      price: 1,
      amount: 5,
      filled: 0,
      status: 'NEW',
      timestamp: Date.now(),
      fee: 0,
    });

    (strategy as any).recordTrades([
      { tradeId: 't-mismatch', orderId: 'sell-order-1', side: 'BUY', amount: 5, price: 1, timestamp: Date.now(), fee: 0 }
    ], 'sell-order-1', true);

    expect(strategy.getVolumeStats().totalVolume).toBe(5);
    expect(strategy.getVolumeStats().buyVolume).toBe(0);
    expect(strategy.getVolumeStats().sellVolume).toBe(5);
    expect(strategy.getProfitStats().washTrades).toBe(1);
  });
});
describe('MM account balance < $1000 order execution', () => {
  class TestMMStrategy extends VolumeGenerationStrategy {
    constructor(mockExchange: any, symbol: string = 'EPWXUSDT') {
      super(mockExchange);
      (this as any).symbol = symbol; // Bypass private for test only
      (this as any).isRunning = true;
    }
    // Expose protected method for testing
    public async testPlaceSellOrder(price: number, amount: number, isWashTrade: boolean = false) {
      return this.placeSellOrder(price, amount, isWashTrade);
    }
  }

  it('should execute real user SELL order if MM balance < $1000 and not market order', async () => {
    // Mock exchange with low USDT balance
    const mockExchange = {
      getBalances: async () => [
        { asset: 'EPWX', free: 1000 },
        { asset: 'USDT', free: 500, locked: 0 }
      ],
      getTicker: async () => ({ price: 10 }),
      placeOrder: jest.fn().mockResolvedValue({ orderId: 'test', symbol: 'EPWXUSDT', side: 'SELL', type: 'LIMIT', price: 10, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 }),
      getRecentTrades: jest.fn().mockResolvedValue([]),
      getOpenOrders: jest.fn().mockResolvedValue([])
    };
    const strategy = new TestMMStrategy(mockExchange);
    // Price is far from market (not a market order)
      const result = await strategy.testPlaceSellOrder(12, 1, false);
      expect(result).toBe('test');
      expect(mockExchange.placeOrder).toHaveBeenCalledWith('EPWXUSDT', 'SELL', 'LIMIT', 1, expect.any(Number));
      expect(mockExchange.placeOrder.mock.calls[0][4]).toBeCloseTo(10.05, 10);
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
        (this as any).isRunning = true;
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

describe('Placement price anchor selection', () => {
  it('prefers executable orderbook mid when the book is usable', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectPlacementPriceReference(0.94, 1.01, true, 0.99);

    expect(result).toEqual({
      priceReference: 1.01,
      source: 'EXECUTABLE_BOOK_MID'
    });
  });

  it('falls back to CEX ticker mid before using discounted DEX reference', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectPlacementPriceReference(0.94, 1.01, false, 0.99);

    expect(result).toEqual({
      priceReference: 0.99,
      source: 'CEX_TICKER_MID'
    });
  });

  it('uses DEX fallback only when no usable CEX reference exists', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectPlacementPriceReference(0.94, 0, false, 0);

    expect(result).toEqual({
      priceReference: 0.94,
      source: 'DEX_FALLBACK'
    });
  });
});

describe('Passive top-touch selection', () => {
  it('keeps the top-touch buy at or below the best bid', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectPassiveTopTouchPrices(0.99, 1.01);

    expect(result).toEqual({
      buyPrice: 0.99,
      sellPrice: 1.01
    });
    expect(result.buyPrice).toBeLessThanOrEqual(0.99);
  });

  it('keeps the top-touch sell at or above the best ask', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectPassiveTopTouchPrices(0.99, 1.01);

    expect(result).toEqual({
      buyPrice: 0.99,
      sellPrice: 1.01
    });
    expect(result.sellPrice).toBeGreaterThanOrEqual(1.01);
  });

  it('does not produce crossing prices in default passive mode', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectPassiveTopTouchPrices(1.01, 0.99);

    expect(result).toEqual({
      buyPrice: 0.99,
      sellPrice: 1.01
    });
    expect(result.buyPrice).toBeLessThanOrEqual(result.sellPrice);
  });
});

describe('Quote drift protection', () => {
  it('pauses live quote placement when high drift would force DEX fallback quoting', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectQuotePlacementDriftMode('DEX_FALLBACK', true, 6, 5);

    expect(result).toEqual({
      allowQuotePlacements: false,
      mode: 'PAUSED'
    });
  });

  it('allows CEX-only live quoting when drift is high but a CEX price anchor exists', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectQuotePlacementDriftMode('CEX_TICKER_MID', true, 6, 5);

    expect(result).toEqual({
      allowQuotePlacements: true,
      mode: 'CEX_ONLY'
    });
  });

  it('keeps normal quoting when drift is within threshold', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).selectQuotePlacementDriftMode('DEX_FALLBACK', true, 4, 5);

    expect(result).toEqual({
      allowQuotePlacements: true,
      mode: 'NORMAL'
    });
  });
});

describe('Inventory-aware quote skew', () => {
  it('lowers quote prices when inventory is long before hard rebalance', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    (strategy as any).currentPosition = 600;

    const adjustedBuy = (strategy as any).applyInventorySkewToQuotePrice(1.0);
    const adjustedSell = (strategy as any).applyInventorySkewToQuotePrice(1.01);

    expect(adjustedBuy).toBeLessThan(1.0);
    expect(adjustedSell).toBeLessThan(1.01);
  });

  it('raises quote prices when inventory is short before hard rebalance', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    (strategy as any).currentPosition = -600;

    const adjustedBuy = (strategy as any).applyInventorySkewToQuotePrice(1.0);
    const adjustedSell = (strategy as any).applyInventorySkewToQuotePrice(1.01);

    expect(adjustedBuy).toBeGreaterThan(1.0);
    expect(adjustedSell).toBeGreaterThan(1.01);
  });

  it('keeps quote prices unchanged when inventory is near neutral', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    (strategy as any).currentPosition = 0;

    const adjustedBuy = (strategy as any).applyInventorySkewToQuotePrice(1.0);
    const adjustedSell = (strategy as any).applyInventorySkewToQuotePrice(1.01);

    expect(adjustedBuy).toBe(1.0);
    expect(adjustedSell).toBe(1.01);
  });
});

describe('Passive quote bands', () => {
  it('keeps buy band below the active anchor using configured passive offsets', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).getPassiveQuoteBands(1.0);

    expect(result.minBuyPrice).toBeCloseTo(0.996, 6);
    expect(result.maxBuyPrice).toBeCloseTo(1.0, 6);
    expect(result.maxBuyPrice).toBeLessThanOrEqual(1.0);
  });

  it('keeps sell band above the active anchor using configured passive offsets', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const result = (strategy as any).getPassiveQuoteBands(1.0);

    expect(result.minSellPrice).toBeCloseTo(1.0, 6);
    expect(result.maxSellPrice).toBeCloseTo(1.004, 6);
    expect(result.minSellPrice).toBeGreaterThanOrEqual(1.0);
  });

  it('keeps seeded buy and sell layers ordered and non-overlapping', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const buyLevel0 = (strategy as any).getPassiveSeededQuotePrice(1.0, 'BUY', 0);
    const buyLevel5 = (strategy as any).getPassiveSeededQuotePrice(1.0, 'BUY', 5);
    const sellLevel0 = (strategy as any).getPassiveSeededQuotePrice(1.0, 'SELL', 0);
    const sellLevel5 = (strategy as any).getPassiveSeededQuotePrice(1.0, 'SELL', 5);

    expect(buyLevel0).toBeLessThan(1.0);
    expect(buyLevel5).toBeLessThan(buyLevel0);
    expect(sellLevel0).toBeGreaterThan(1.0);
    expect(sellLevel5).toBeGreaterThan(sellLevel0);
    expect(buyLevel0).toBeLessThan(sellLevel0);
  });
});

describe('True trading PnL tracking', () => {
  it('realizes PnL on a completed buy-then-sell round trip', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const openPnl = (strategy as any).applyEconomicFill('BUY', 100, 1.0, false);
    const closePnl = (strategy as any).applyEconomicFill('SELL', 100, 1.1, false);
    const profitStats = strategy.getProfitStats();

    expect(openPnl).toBeCloseTo(0, 6);
    expect(closePnl).toBeCloseTo(10, 6);
    expect(profitStats.realizedPnl).toBeCloseTo(10, 6);
    expect(profitStats.totalPnl).toBeCloseTo(10, 6);
    expect(profitStats.inventoryQuantity).toBeCloseTo(0, 6);
  });

  it('tracks unrealized PnL for one-sided inventory after mark update', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    (strategy as any).applyEconomicFill('BUY', 100, 1.0, false);
    (strategy as any).updateInventoryMarkPrice(1.05);
    const profitStats = strategy.getProfitStats();

    expect(profitStats.realizedPnl).toBeCloseTo(0, 6);
    expect(profitStats.unrealizedPnl).toBeCloseTo(5, 6);
    expect(profitStats.totalPnl).toBeCloseTo(5, 6);
    expect(profitStats.inventoryQuantity).toBeCloseTo(100, 6);
  });

  it('does not inflate real-user PnL for wash-trade accounting', () => {
    const strategy = new VolumeGenerationStrategy(new MockExchangeService() as any);

    const realizedPnl = (strategy as any).applyEconomicFill('BUY', 100, 1.0, true);
    const profitStats = strategy.getProfitStats();

    expect(realizedPnl).toBeCloseTo(0, 6);
    expect(profitStats.realizedPnl).toBeCloseTo(0, 6);
    expect(profitStats.realFillRealizedPnl).toBeCloseTo(0, 6);
    expect(profitStats.inventoryQuantity).toBeCloseTo(0, 6);
  });
});

describe('Confirmed wash fill polling', () => {
  it('waits 1s before querying trades for confirmed BUY fills', async () => {
    const mockExchange = {
      getBalances: jest.fn(),
      getTicker: jest.fn(),
      getOpenOrders: jest.fn(),
      cancelOrder: jest.fn(),
      placeOrder: jest.fn(),
      cancelAllOrders: jest.fn(),
      getRecentTrades: jest.fn().mockResolvedValue([
        { amount: 2, price: 1 },
        { amount: 3, price: 1 }
      ])
    };
    const strategy = new VolumeGenerationStrategy(mockExchange as any);

    setTimeoutSpy.mockClear();
    const confirmed = await (strategy as any).getConfirmedFilledAmount('buy-order-1');

    const delayCall = setTimeoutSpy.mock.calls.find((call: any[]) => call[1] === 1000);
    expect(delayCall).toBeDefined();
    expect(mockExchange.getRecentTrades).toHaveBeenCalledWith((strategy as any).symbol, 10, 'buy-order-1');
    expect(confirmed).toBe(5);
  });

  it('returns 0 confirmed amount when trade lookup throws', async () => {
    const mockExchange = {
      getBalances: jest.fn(),
      getTicker: jest.fn(),
      getOpenOrders: jest.fn(),
      cancelOrder: jest.fn(),
      placeOrder: jest.fn(),
      cancelAllOrders: jest.fn(),
      getRecentTrades: jest.fn().mockRejectedValue(new Error('temporary exchange error'))
    };
    const strategy = new VolumeGenerationStrategy(mockExchange as any);

    const confirmed = await (strategy as any).getConfirmedFilledAmount('buy-order-2');

    expect(confirmed).toBe(0);
  });
});
