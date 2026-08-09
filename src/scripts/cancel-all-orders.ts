function isCancelConfirmed(): boolean {
  return (process.env.CONFIRM_CANCEL_ALL_ORDERS || '').toLowerCase() === 'true';
}

async function main() {
  if (!isCancelConfirmed()) {
    console.error(
      'Refusing to cancel orders: set CONFIRM_CANCEL_ALL_ORDERS=true to run this destructive operation intentionally.'
    );
    process.exit(1);
  }

  const [{ createExchangeService }, { config }] = await Promise.all([
    import('../services/exchange.factory'),
    import('../config'),
  ]);
  const symbol = config.trading.pair || 'EPWX/USDT';

  const exchange = createExchangeService();
  try {
    let totalCancelled = 0;
    while (true) {
      console.log('Fetching open orders for', symbol);
      const openOrders = await exchange.getOpenOrders(symbol);
      if (!openOrders.length) {
        break;
      }

      for (const order of openOrders) {
        await exchange.cancelOrder(symbol, order.orderId);
        totalCancelled += 1;
      }

      console.log(`Cancelled ${openOrders.length} order(s) in this pass.`);
    }
    console.log(`✅ Cancelled ${totalCancelled} existing orders`);
  } catch (err: any) {
    console.error('Error cancelling orders:', err.message);
  }
}

main();