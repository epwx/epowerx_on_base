import { BiconomyExchangeService } from '../services/biconomy-exchange.service';
import { config } from '../config';
const symbol = config.trading.pair || 'EPWX/USDT';

async function main() {
  const exchange = new BiconomyExchangeService();
  try {
    console.log('Cancelling all orders for', symbol);
    const cancelled = await exchange.cancelAllOrders(symbol);
    console.log(`✅ Cancelled ${cancelled} existing orders`);
  } catch (err: any) {
    console.error('Error cancelling orders:', err.message);
  }
}

main();