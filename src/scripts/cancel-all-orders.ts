import { BiconomyExchangeService } from '../services/biconomy-exchange.service';
import { config } from '../config';
const symbol = config.trading.pair || 'EPWX/USDT';

async function main() {
  const exchange = new BiconomyExchangeService();
  try {
    console.log('Fetching open orders for', symbol);
    // Fetch open orders (unfilled)
    const openOrders = await exchange.getOpenOrders(symbol);
    if (!openOrders.length) {
      console.log('No open orders to cancel.');
      return;
    }
    // Cancel in batches of 10
    let totalCancelled = 0;
    for (let i = 0; i < openOrders.length; i += 10) {
      const batch = openOrders.slice(i, i + 10);
      const ordersJson = batch.map((order: { orderId: string }) => ({ market: symbol.replace('/', '_').toUpperCase(), order_id: order.orderId }));
      const cancelled = await exchange.cancelOrdersBatch(ordersJson);
      totalCancelled += cancelled;
      console.log(`Batch cancelled: ${cancelled} orders`);
    }
    console.log(`✅ Cancelled ${totalCancelled} existing orders`);
  } catch (err: any) {
    console.error('Error cancelling orders:', err.message);
  }
}

main();