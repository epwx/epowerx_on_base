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
  };
  
  volumeStrategy: {
    volumeTargetDaily: number;
    minOrderSize: number;
    maxOrderSize: number;
    spreadPercentage: number;
    orderFrequency: number;
    selfTradeEnabled: boolean;
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
  },
  
  volumeStrategy: {
    volumeTargetDaily: getEnvNumber('VOLUME_TARGET_DAILY', 100000),
    minOrderSize: getEnvNumber('MIN_ORDER_SIZE', 50),
    maxOrderSize: getEnvNumber('MAX_ORDER_SIZE', 500),
    spreadPercentage: getEnvNumber('SPREAD_PERCENTAGE', 0.1),
    orderFrequency: getEnvNumber('ORDER_FREQUENCY', 5000),
    selfTradeEnabled: getEnvBoolean('SELF_TRADE_ENABLED', true),
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
