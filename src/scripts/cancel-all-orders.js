// cancel-all-orders.js
const { BiconomyExchangeService } = require('../services/biconomy-exchange.service');
const { config } = require('../config');
const symbol = config.symbol || 'EPWX/USDT';

async function main() {
  const exchange = new BiconomyExchangeService();
  try {
    console.log('Cancelling all orders for', symbol);
    const cancelled = await exchange.cancelAllOrders(symbol);
    console.log(`✅ Cancelled ${cancelled} existing orders`);
  } catch (err) {
    console.error('Error cancelling orders:', err.message);
  }
}

main();