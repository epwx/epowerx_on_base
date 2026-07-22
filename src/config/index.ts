import dotenv from 'dotenv';

dotenv.config();

interface Config {
  biconomyExchange: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
  };

  trading: {
    pair: string;
    epwxAddress: string;
    epwxWethPairAddress: string;
    baseRpcUrl: string;
  };

  volumeStrategy: {
    volumeTargetDaily: number;
    minOrderSize: number;
    maxOrderSize: number;
    maxOrderAmountTokens: number;
    spreadPercentage: number;
    orderFrequency: number;
    selfTradeEnabled: boolean;
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
    inventorySkewMaxPercent: number;
    inventorySkewActivationRatio: number;
    passiveBuyBandOuterOffsetPercent: number;
    passiveBuyBandInnerOffsetPercent: number;
    passiveSellBandInnerOffsetPercent: number;
    passiveSellBandOuterOffsetPercent: number;
    passiveSeedBaseOffsetPercent: number;
    passiveSeedStepOffsetPercent: number;
  };

  marketMaking: {
    maxPositionSize: number;
    positionRebalanceThreshold: number;
    updateInterval: number;
  };

  risk: {
    maxSlippage: number;
    dailyLossLimit: number;
    enablePositionLimits: boolean;
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

export const config: Config = {
  biconomyExchange: {
    apiKey: getEnvVariable('BICONOMY_EXCHANGE_API_KEY'),
    apiSecret: getEnvVariable('BICONOMY_EXCHANGE_API_SECRET'),
    baseUrl: getEnvVariable('BICONOMY_EXCHANGE_BASE_URL', 'https://api.biconomy.exchange'),
  },

  trading: {
    pair: getEnvVariable('TRADING_PAIR', 'EPWX/USDT'),
    epwxAddress: getEnvVariable('EPWX_TOKEN_ADDRESS', '0xeF5f5751cf3eCA6cC3572768298B7783d33D60Eb'),
    epwxWethPairAddress: getEnvVariable('EPWX_WETH_PAIR', ''),
    baseRpcUrl: getEnvVariable('BASE_RPC_URL', ''),
  },

  volumeStrategy: {
    volumeTargetDaily: getEnvNumber('VOLUME_TARGET_DAILY', 100000),
    minOrderSize: getEnvNumber('MIN_ORDER_SIZE', 50),
    maxOrderSize: getEnvNumber('MAX_ORDER_SIZE', 500),
    maxOrderAmountTokens: getEnvNumber('MAX_ORDER_AMOUNT_TOKENS', 500000000000000),
    spreadPercentage: getEnvNumber('SPREAD_PERCENTAGE', 0.1),
    orderFrequency: getEnvNumber('ORDER_FREQUENCY', 5000),
    selfTradeEnabled: getEnvBoolean('SELF_TRADE_ENABLED', true),
    mirrorMarkupPercentage: getEnvNumber('MIRROR_MARKUP_PERCENTAGE', 2), // default 2%
    balanceUtilizationPercent: getEnvNumber('BALANCE_UTILIZATION_PERCENT', 0.92),
    idleBalanceReserveUsd: getEnvNumber('IDLE_BALANCE_RESERVE_USD', 25),
    maxDexCexDriftPercent: getEnvNumber('MAX_DEX_CEX_DRIFT_PERCENT', 5),
    pauseWashOnHighDrift: getEnvBoolean('PAUSE_WASH_ON_HIGH_DRIFT', true),
    washReservedPlacementsPerCycle: getEnvNumber('WASH_RESERVED_PLACEMENTS_PER_CYCLE', 6),
    washOrderSizeCapUsd: getEnvNumber('WASH_ORDER_SIZE_CAP_USD', 25),
    washUsdtScaleThreshold: getEnvNumber('WASH_USDT_SCALE_THRESHOLD', 250),
    washBasePairsPerCycle: getEnvNumber('WASH_BASE_PAIRS_PER_CYCLE', 0),
    washMaxPairsPerCycle: getEnvNumber('WASH_MAX_PAIRS_PER_CYCLE', 3),
    inventorySkewMaxPercent: getEnvNumber('INVENTORY_SKEW_MAX_PERCENT', 0.003),
    inventorySkewActivationRatio: getEnvNumber('INVENTORY_SKEW_ACTIVATION_RATIO', 0.15),
    passiveBuyBandOuterOffsetPercent: getEnvNumber('PASSIVE_BUY_BAND_OUTER_OFFSET_PERCENT', 0.004),
    passiveBuyBandInnerOffsetPercent: getEnvNumber('PASSIVE_BUY_BAND_INNER_OFFSET_PERCENT', 0),
    passiveSellBandInnerOffsetPercent: getEnvNumber('PASSIVE_SELL_BAND_INNER_OFFSET_PERCENT', 0),
    passiveSellBandOuterOffsetPercent: getEnvNumber('PASSIVE_SELL_BAND_OUTER_OFFSET_PERCENT', 0.004),
    passiveSeedBaseOffsetPercent: getEnvNumber('PASSIVE_SEED_BASE_OFFSET_PERCENT', 0.001),
    passiveSeedStepOffsetPercent: getEnvNumber('PASSIVE_SEED_STEP_OFFSET_PERCENT', 0.0001),
  },

  marketMaking: {
    maxPositionSize: getEnvNumber('MAX_POSITION_SIZE', 5000),
    positionRebalanceThreshold: getEnvNumber('POSITION_REBALANCE_THRESHOLD', 1000),
    updateInterval: getEnvNumber('UPDATE_INTERVAL', 3000),
  },

  risk: {
    maxSlippage: getEnvNumber('MAX_SLIPPAGE', 0.5),
    dailyLossLimit: getEnvNumber('DAILY_LOSS_LIMIT', 1000),
    enablePositionLimits: getEnvBoolean('ENABLE_POSITION_LIMITS', true),
  },

  logLevel: getEnvVariable('LOG_LEVEL', 'info'),
};

export default config;
