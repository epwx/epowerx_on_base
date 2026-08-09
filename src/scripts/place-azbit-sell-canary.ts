import { config } from '../config';
import { AzbitExchangeService } from '../services/azbit-exchange.service';

const getRequiredPositiveNumber = (key: string): number => {
  const value = Number(process.env[key]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
};

async function main(): Promise<void> {
  if (process.env.CONFIRM_AZBIT_SELL_CANARY !== 'true') {
    throw new Error('Refusing placement: set CONFIRM_AZBIT_SELL_CANARY=true');
  }
  if (config.exchange.name !== 'azbit') {
    throw new Error(`Refusing placement on exchange=${config.exchange.name}`);
  }
  if (config.azbitExchange.readOnly) {
    throw new Error('AZBIT_READ_ONLY must be false for the one-shot canary process');
  }
  if ((process.env.AZBIT_SHADOW_MODE || '').toLowerCase() !== 'false') {
    throw new Error('Explicit AZBIT_SHADOW_MODE=false is required for the one-shot canary process');
  }

  const amount = getRequiredPositiveNumber('AZBIT_CANARY_AMOUNT_EPWX');
  const price = getRequiredPositiveNumber('AZBIT_CANARY_PRICE_USDT');
  const maxNotionalUsd = Number(process.env.AZBIT_CANARY_MAX_NOTIONAL_USD || 0.6);
  const notionalUsd = amount * price;

  if (!Number.isFinite(maxNotionalUsd) || maxNotionalUsd <= 0 || notionalUsd > maxNotionalUsd) {
    throw new Error(
      `Canary notional $${notionalUsd.toFixed(8)} exceeds cap $${maxNotionalUsd.toFixed(8)}`
    );
  }

  const exchange = new AzbitExchangeService();
  const symbol = config.trading.pair;
  const existingOrders = await exchange.getOpenOrders(symbol);
  if (existingOrders.length > 0) {
    throw new Error(`Refusing placement: account already has ${existingOrders.length} open order(s)`);
  }

  const order = await exchange.placeOrder(symbol, 'SELL', 'LIMIT', amount, price);
  const openOrders = await exchange.getOpenOrders(symbol);
  const visibleOrder = openOrders.find((entry) => entry.orderId === order.orderId);

  console.log(`Accepted Azbit SELL canary order ${order.orderId}`);
  console.log(`Requested amount=${amount} price=${price} notional=$${notionalUsd.toFixed(8)}`);
  console.log(`Visible in open orders=${Boolean(visibleOrder)} totalOpenOrders=${openOrders.length}`);

  if (!visibleOrder) {
    throw new Error('Canary was accepted but is not visible in open orders; inspect private fills before retrying');
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Azbit SELL canary failed: ${message}`);
  process.exit(1);
});