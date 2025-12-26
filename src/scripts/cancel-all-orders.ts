import { BiconomyExchangeService } from '../services/biconomy-exchange.service';
import { config } from '../config';
const symbol = config.trading.pair || 'EPWX/USDT';

async function main() {
  const exchange = new BiconomyExchangeService();
  try {
    let totalCancelled = 0;
    while (true) {
      console.log('Fetching open orders for', symbol);
      const openOrders = await exchange.getOpenOrders(symbol);
      if (!openOrders.length) {
        break;
      }
      // Cancel in batches of 100
      for (let i = 0; i < openOrders.length; i += 100) {
        const batch = openOrders.slice(i, i + 100);
        const ordersJson = batch.map((order: { orderId: string }) => ({ market: symbol.replace('/', '_').toUpperCase(), order_id: order.orderId }));
        const cancelled = await exchange.cancelOrdersBatch(ordersJson);
        totalCancelled += cancelled;
        console.log(`Batch cancelled: ${cancelled} orders`);
      }
    }
    console.log(`✅ Cancelled ${totalCancelled} existing orders`);
  } catch (err: any) {
    console.error('Error cancelling orders:', err.message);
  }
}

main();