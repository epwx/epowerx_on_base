import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

interface Config {
  exchange: {
    name: 'biconomy' | 'azbit';
  };

  biconomyExchange: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
  };

  azbitExchange: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
    readOnly: boolean;
    shadowMode: boolean;
  };

  trading: {
    pair: string;
    epwxAddress: string;
    epwxWethPairAddress: string;
    baseRpcUrl: string;
    ethUsdSource: 'chainlink' | 'coingecko' | 'static';
    ethUsdChainlinkFeedAddress: string;
    ethUsdFallback: number;
    coingeckoEthUsdUrl: string;
    ethUsdCacheMs: number;
  };

  volumeStrategy: {
    volumeTargetDaily: number;
    minOrderSize: number;
    maxOrderSize: number;
    maxOrderAmountTokens: number;
    targetOrdersPerSide: number;
    targetBuyOrders: number;
    targetSellOrders: number;
    targetBuyDepthUsd: number;
    targetSellDepthUsd: number;
    spreadPercentage: number;
    orderFrequency: number;
    forceBuyPause: boolean;
    buyReactivationMode: 'off' | 'auto' | 'on';
    minNetEdgeBps: number;
    maxExecSpreadPercent: number;
    executableSpreadCircuitBreakerPercent: number;
    minExecDepthBuyUsd: number;
    minExecDepthSellUsd: number;
    adverseFillRatioMax: number;
    adverseFillInventoryLimitUsd: number;
    riskSizeMultiplierDefensive: number;
    riskSizeMultiplierNormal: number;
    selfTradeEnabled: boolean;
    selfTradeMode: 'off' | 'on' | 'auto';
    idleWashEnableAfterMs: number;
    idleWashCooldownAfterRealFillMs: number;
    idleWashMaxPairsPerCycle: number;
    idleWashRequireLowDrift: boolean;
    idleWashMaxDriftPercent: number;
    idleWashMaxExecSpreadPercent: number;
    mirrorMarkupPercentage: number;
    balanceUtilizationPercent: number;
    idleBalanceReserveUsd: number;
    maxDexCexDriftPercent: number;
    pauseWashOnHighDrift: boolean;
    washReservedPlacementsPerCycle: number;
    washOrderSizeCapUsd: number;
    washUsdtScaleThreshold: number;
    washBasePairsPerCycle: number;
    washMaxPairsPerCycle: number;
    idleWashSamePriceUpwardStepBpsPerMinute: number;
    idleWashSamePriceUpwardMaxBps: number;
    idleWashProtectExternalBuys: boolean;
    idleWashProtectMinSpreadTicks: number;
    inventorySkewMaxPercent: number;
    inventorySkewActivationRatio: number;
    passiveBuyBandOuterOffsetPercent: number;
    passiveBuyBandInnerOffsetPercent: number;
    passiveSellBandInnerOffsetPercent: number;
    passiveSellBandOuterOffsetPercent: number;
    passiveSeedBaseOffsetPercent: number;
    passiveSeedStepOffsetPercent: number;
    quoteChurnRefreshPerSide: number;
    topTouchImprovementSpreadFraction: number;
    sellNearBidEnabled: boolean;
    sellNearBidTicks: number;
    sellNearBidMinMarkupBps: number;
    latestPriceBandHalfWidthPercent: number;
    dexPriceDiscountPercent: number;
    dexAnchoredQuotingEnabled: boolean;
    dexAnchoredSellMinPremiumBps: number;
    dexAnchoredBuyMaxDiscountBps: number;
  };

  marketMaking: {
    maxPositionSize: number;
    positionRebalanceThreshold: number;
    updateInterval: number;
    rebalanceCooldownMs: number;
    rebalanceMaxSpreadPercent: number;
    rebalanceMaxPriceDeviationPercent: number;
  };

  risk: {
    maxSlippage: number;
    dailyLossLimit: number;
    enablePositionLimits: boolean;
  };

  operations: {
    cancelOrdersOnStart: boolean;
    cancelOrdersOnStop: boolean;
  };

  runtime: {
    stateFile: string;
    logFilePrefix: string;
  };

  logLevel: string;
}

const getEnvVariable = (key: string, defaultValue?: string): string => {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
};

const getEnvNumber = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
};

const getEnvBoolean = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
};

const getEnvBuyReactivationMode = (key: string, defaultValue: 'off' | 'auto' | 'on'): 'off' | 'auto' | 'on' => {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'auto' || normalized === 'on') {
    return normalized;
  }

  return defaultValue;
};

const getEnvSelfTradeMode = (key: string, defaultValue: 'off' | 'auto' | 'on'): 'off' | 'auto' | 'on' => {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'auto' || normalized === 'on') {
    return normalized;
  }

  return defaultValue;
};

const getEnvEthUsdSource = (
  key: string,
  defaultValue: 'chainlink' | 'coingecko' | 'static'
): 'chainlink' | 'coingecko' | 'static' => {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'chainlink' || normalized === 'coingecko' || normalized === 'static') {
    return normalized;
  }

  return defaultValue;
};

const getEnvExchangeName = (
  key: string,
  defaultValue: 'biconomy' | 'azbit'
): 'biconomy' | 'azbit' => {
  const value = process.env[key];
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'biconomy' || normalized === 'azbit') {
    return normalized;
  }

  return defaultValue;
};

const getCancelOrdersDefault = (): boolean => {
  const legacyValue = process.env.CANCEL_ORDERS_ON_DEPLOY;
  if (!legacyValue) {
    return true;
  }

  return legacyValue.trim().toLowerCase() === 'true';
};

const selectedExchange = getEnvExchangeName('EXCHANGE_NAME', 'biconomy');
const azbitReadOnly = getEnvBoolean('AZBIT_READ_ONLY', true);

export const config: Config = {
  exchange: {
    name: selectedExchange,
  },

  biconomyExchange: {
    apiKey: selectedExchange === 'biconomy'
      ? getEnvVariable('BICONOMY_EXCHANGE_API_KEY')
      : (process.env.BICONOMY_EXCHANGE_API_KEY || ''),
    apiSecret: selectedExchange === 'biconomy'
      ? getEnvVariable('BICONOMY_EXCHANGE_API_SECRET')
      : (process.env.BICONOMY_EXCHANGE_API_SECRET || ''),
    baseUrl: getEnvVariable('BICONOMY_EXCHANGE_BASE_URL', 'https://api.biconomy.exchange'),
  },

  azbitExchange: {
    apiKey: process.env.AZBIT_API_KEY || '',
    apiSecret: process.env.AZBIT_API_SECRET || '',
    baseUrl: getEnvVariable('AZBIT_EXCHANGE_BASE_URL', 'https://data.azbit.com'),
    readOnly: azbitReadOnly,
    shadowMode: getEnvBoolean('AZBIT_SHADOW_MODE', false),
  },

  trading: {
    pair: getEnvVariable('TRADING_PAIR', selectedExchange === 'azbit' ? 'EPWX_USDT' : 'EPWX/USDT'),
    epwxAddress: getEnvVariable('EPWX_TOKEN_ADDRESS', '0xeF5f5751cf3eCA6cC3572768298B7783d33D60Eb'),
    epwxWethPairAddress: selectedExchange === 'biconomy'
      ? getEnvVariable('EPWX_WETH_PAIR')
      : (process.env.EPWX_WETH_PAIR || ''),
    baseRpcUrl: selectedExchange === 'biconomy'
      ? getEnvVariable('BASE_RPC_URL')
      : (process.env.BASE_RPC_URL || ''),
    ethUsdSource: getEnvEthUsdSource('ETH_USD_SOURCE', 'chainlink'),
    ethUsdChainlinkFeedAddress: process.env.ETH_USD_CHAINLINK_FEED_ADDRESS || '',
    ethUsdFallback: getEnvNumber('ETH_USD_FALLBACK', 2200),
    coingeckoEthUsdUrl: getEnvVariable(
      'COINGECKO_ETH_USD_URL',
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    ),
    ethUsdCacheMs: getEnvNumber('ETH_USD_CACHE_MS', 120000),
  },

  volumeStrategy: {
    volumeTargetDaily: getEnvNumber('VOLUME_TARGET_DAILY', 100000),
    minOrderSize: getEnvNumber('MIN_ORDER_SIZE', 50),
    maxOrderSize: getEnvNumber('MAX_ORDER_SIZE', 500),
    maxOrderAmountTokens: getEnvNumber('MAX_ORDER_AMOUNT_TOKENS', 500000000000000),
    targetOrdersPerSide: getEnvNumber('TARGET_ORDERS_PER_SIDE', 30),
    targetBuyOrders: getEnvNumber('TARGET_BUY_ORDERS', getEnvNumber('TARGET_ORDERS_PER_SIDE', 30)),
    targetSellOrders: getEnvNumber('TARGET_SELL_ORDERS', getEnvNumber('TARGET_ORDERS_PER_SIDE', 30)),
    targetBuyDepthUsd: getEnvNumber('TARGET_BUY_DEPTH_USD', 200),
    targetSellDepthUsd: getEnvNumber('TARGET_SELL_DEPTH_USD', 200),
    spreadPercentage: getEnvNumber('SPREAD_PERCENTAGE', 0.1),
    orderFrequency: getEnvNumber('ORDER_FREQUENCY', 5000),
    forceBuyPause: getEnvBoolean('FORCE_BUY_PAUSE', false),
    buyReactivationMode: getEnvBuyReactivationMode('BUY_REACTIVATION_MODE', 'on'),
    minNetEdgeBps: getEnvNumber('MIN_NET_EDGE_BPS', 0),
    maxExecSpreadPercent: getEnvNumber('MAX_EXEC_SPREAD_PERCENT', 8),
    executableSpreadCircuitBreakerPercent: getEnvNumber('MAX_EXECUTABLE_SPREAD_CIRCUIT_BREAKER_PERCENT', 3),
    minExecDepthBuyUsd: getEnvNumber('MIN_EXEC_DEPTH_BUY_USD', 0),
    minExecDepthSellUsd: getEnvNumber('MIN_EXEC_DEPTH_SELL_USD', 0),
    adverseFillRatioMax: getEnvNumber('ADVERSE_FILL_RATIO_MAX', 1.6),
    adverseFillInventoryLimitUsd: getEnvNumber('ADVERSE_FILL_INVENTORY_LIMIT_USD', 0),
    riskSizeMultiplierDefensive: getEnvNumber('RISK_SIZE_MULTIPLIER_DEFENSIVE', 1),
    riskSizeMultiplierNormal: getEnvNumber('RISK_SIZE_MULTIPLIER_NORMAL', 1),
    selfTradeEnabled: getEnvBoolean('SELF_TRADE_ENABLED', true),
    selfTradeMode: getEnvSelfTradeMode(
      'SELF_TRADE_MODE',
      getEnvBoolean('SELF_TRADE_ENABLED', true) ? 'on' : 'off'
    ),
    idleWashEnableAfterMs: getEnvNumber('IDLE_WASH_ENABLE_AFTER_MS', 15 * 60 * 1000),
    idleWashCooldownAfterRealFillMs: getEnvNumber('IDLE_WASH_COOLDOWN_AFTER_REAL_FILL_MS', 30 * 60 * 1000),
    idleWashMaxPairsPerCycle: getEnvNumber('IDLE_WASH_MAX_PAIRS_PER_CYCLE', 1),
    idleWashRequireLowDrift: getEnvBoolean('IDLE_WASH_REQUIRE_LOW_DRIFT', true),
    idleWashMaxDriftPercent: getEnvNumber('IDLE_WASH_MAX_DRIFT_PERCENT', 3),
    idleWashMaxExecSpreadPercent: getEnvNumber('IDLE_WASH_MAX_EXEC_SPREAD_PERCENT', 8),
    mirrorMarkupPercentage: getEnvNumber('MIRROR_MARKUP_PERCENTAGE', 2), // default 2%
    balanceUtilizationPercent: getEnvNumber('BALANCE_UTILIZATION_PERCENT', 0.92),
    idleBalanceReserveUsd: getEnvNumber('IDLE_BALANCE_RESERVE_USD', 25),
    maxDexCexDriftPercent: getEnvNumber('MAX_DEX_CEX_DRIFT_PERCENT', 5),
    dexPriceDiscountPercent: getEnvNumber('DEX_PRICE_DISCOUNT_PERCENT', 6),
    pauseWashOnHighDrift: getEnvBoolean('PAUSE_WASH_ON_HIGH_DRIFT', true),
    washReservedPlacementsPerCycle: getEnvNumber('WASH_RESERVED_PLACEMENTS_PER_CYCLE', 6),
    washOrderSizeCapUsd: getEnvNumber('WASH_ORDER_SIZE_CAP_USD', 25),
    washUsdtScaleThreshold: getEnvNumber('WASH_USDT_SCALE_THRESHOLD', 250),
    washBasePairsPerCycle: getEnvNumber('WASH_BASE_PAIRS_PER_CYCLE', 0),
    washMaxPairsPerCycle: getEnvNumber('WASH_MAX_PAIRS_PER_CYCLE', 3),
    idleWashSamePriceUpwardStepBpsPerMinute: getEnvNumber('IDLE_WASH_SAME_PRICE_UPWARD_STEP_BPS_PER_MINUTE', 0),
    idleWashSamePriceUpwardMaxBps: getEnvNumber('IDLE_WASH_SAME_PRICE_UPWARD_MAX_BPS', 0),
    idleWashProtectExternalBuys: getEnvBoolean('IDLE_WASH_PROTECT_EXTERNAL_BUYS', false),
    idleWashProtectMinSpreadTicks: getEnvNumber('IDLE_WASH_PROTECT_MIN_SPREAD_TICKS', 2),
    inventorySkewMaxPercent: getEnvNumber('INVENTORY_SKEW_MAX_PERCENT', 0.003),
    inventorySkewActivationRatio: getEnvNumber('INVENTORY_SKEW_ACTIVATION_RATIO', 0.15),
    passiveBuyBandOuterOffsetPercent: getEnvNumber('PASSIVE_BUY_BAND_OUTER_OFFSET_PERCENT', 0.004),
    passiveBuyBandInnerOffsetPercent: getEnvNumber('PASSIVE_BUY_BAND_INNER_OFFSET_PERCENT', 0),
    passiveSellBandInnerOffsetPercent: getEnvNumber('PASSIVE_SELL_BAND_INNER_OFFSET_PERCENT', 0),
    passiveSellBandOuterOffsetPercent: getEnvNumber('PASSIVE_SELL_BAND_OUTER_OFFSET_PERCENT', 0.004),
    passiveSeedBaseOffsetPercent: getEnvNumber('PASSIVE_SEED_BASE_OFFSET_PERCENT', 0.001),
    passiveSeedStepOffsetPercent: getEnvNumber('PASSIVE_SEED_STEP_OFFSET_PERCENT', 0.0001),
    quoteChurnRefreshPerSide: getEnvNumber('QUOTE_CHURN_REFRESH_PER_SIDE', 2),
    topTouchImprovementSpreadFraction: getEnvNumber('TOP_TOUCH_IMPROVEMENT_SPREAD_FRACTION', 0),
    sellNearBidEnabled: getEnvBoolean('SELL_NEAR_BID_ENABLED', false),
    sellNearBidTicks: getEnvNumber('SELL_NEAR_BID_TICKS', 1),
    sellNearBidMinMarkupBps: getEnvNumber('SELL_NEAR_BID_MIN_MARKUP_BPS', 1),
    latestPriceBandHalfWidthPercent: getEnvNumber('LATEST_PRICE_BAND_HALF_WIDTH_PERCENT', 0.5),
    dexAnchoredQuotingEnabled: getEnvBoolean('DEX_ANCHORED_QUOTING_ENABLED', false),
    dexAnchoredSellMinPremiumBps: getEnvNumber('DEX_ANCHORED_SELL_MIN_PREMIUM_BPS', 100),
    dexAnchoredBuyMaxDiscountBps: getEnvNumber('DEX_ANCHORED_BUY_MAX_DISCOUNT_BPS', 100),
  },

  marketMaking: {
    maxPositionSize: getEnvNumber('MAX_POSITION_SIZE', 5000),
    positionRebalanceThreshold: getEnvNumber('POSITION_REBALANCE_THRESHOLD', 1000),
    updateInterval: getEnvNumber('UPDATE_INTERVAL', 3000),
    rebalanceCooldownMs: getEnvNumber('REBALANCE_COOLDOWN_MS', 45000),
    rebalanceMaxSpreadPercent: getEnvNumber('REBALANCE_MAX_SPREAD_PERCENT', 5),
    rebalanceMaxPriceDeviationPercent: getEnvNumber('REBALANCE_MAX_PRICE_DEVIATION_PERCENT', 5),
  },

  risk: {
    maxSlippage: getEnvNumber('MAX_SLIPPAGE', 0.5),
    dailyLossLimit: getEnvNumber('DAILY_LOSS_LIMIT', 1000),
    enablePositionLimits: getEnvBoolean('ENABLE_POSITION_LIMITS', true),
  },

  operations: {
    cancelOrdersOnStart: getEnvBoolean('CANCEL_ORDERS_ON_START', getCancelOrdersDefault()),
    cancelOrdersOnStop: getEnvBoolean('CANCEL_ORDERS_ON_STOP', getCancelOrdersDefault()),
  },

  runtime: {
    stateFile: getEnvVariable('RUNTIME_STATE_FILE', `logs/runtime-pnl-state.${selectedExchange}.json`),
    logFilePrefix: process.env.LOG_FILE_PREFIX || '',
  },

  logLevel: getEnvVariable('LOG_LEVEL', 'info'),
};

export default config;
