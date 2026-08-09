import { createExchangeService } from '../services/exchange.factory';
import { logger } from '../utils/logger';
import { config } from '../config';

async function testConnection() {
  logger.info(`🧪 Testing ${config.exchange.name.toUpperCase()} Exchange Connection...`);
  logger.info('');

  const exchange = createExchangeService();
  const symbol = config.trading.pair;
  const hasPrivateAuth =
    config.exchange.name !== 'azbit' ||
    (Boolean(config.azbitExchange.apiKey) && Boolean(config.azbitExchange.apiSecret));

  try {
    // Test 1: Get Ticker
    logger.info('📊 Test 1: Fetching ticker data...');
    const ticker = await exchange.getTicker(symbol);
    logger.info(`✅ Ticker: ${symbol}`);
    logger.info(`   Last Price: $${ticker.price.toExponential(6)}`);
    logger.info(`   Bid: $${ticker.bid.toExponential(6)}`);
    logger.info(`   Ask: $${ticker.ask.toExponential(6)}`);
    logger.info(`   24h Volume: $${ticker.volume24h.toFixed(2)}`);
    logger.info(`   24h High: $${ticker.high24h.toExponential(6)}`);
    logger.info(`   24h Low: $${ticker.low24h.toExponential(6)}`);
    logger.info('');

    // Test 2: Get Order Book
    logger.info('📚 Test 2: Fetching order book...');
    const orderBook = await exchange.getOrderBook(symbol);
    logger.info(`✅ Order Book: ${symbol}`);
    logger.info('   Top 5 Bids:');
    orderBook.bids.slice(0, 5).forEach(([price, amount], i) => {
      logger.info(`   ${i + 1}. $${price.toExponential(6)} - ${amount.toFixed(2)}`);
    });
    logger.info('   Top 5 Asks:');
    orderBook.asks.slice(0, 5).forEach(([price, amount], i) => {
      logger.info(`   ${i + 1}. $${price.toExponential(6)} - ${amount.toFixed(2)}`);
    });
    logger.info('');

    if (hasPrivateAuth) {
      // Test 3: Get Balances
      logger.info('💰 Test 3: Fetching account balances...');
      const balances = await exchange.getBalances();
      logger.info(`✅ Account Balances:`);
      balances
        .filter(b => b.total > 0)
        .forEach(b => {
          logger.info(`   ${b.asset}: ${b.total.toFixed(8)} (Free: ${b.free.toFixed(8)}, Locked: ${b.locked.toFixed(8)})`);
        });
      logger.info('');

      // Test 4: Get Open Orders
      logger.info('📋 Test 4: Fetching open orders...');
      const openOrders = await exchange.getOpenOrders(symbol);
      logger.info(`✅ Open Orders: ${openOrders.length}`);
      if (openOrders.length > 0) {
        openOrders.forEach(order => {
          logger.info(`   ${order.side} ${order.amount} @ $${order.price} (Status: ${order.status})`);
        });
      } else {
        logger.info('   No open orders');
      }
      logger.info('');
    } else {
      logger.info('⚠️  Skipping private account tests (balances/open orders): set AZBIT_API_KEY and AZBIT_API_SECRET.');
      logger.info('');
    }

    // Test 5: Get Recent Trades
    logger.info('📈 Test 5: Fetching recent trades...');
    const trades = await exchange.getRecentTrades(symbol, 10);
    if (trades.length > 0) {
      logger.info(`✅ Recent Trades: ${trades.length}`);
      trades.slice(0, 5).forEach((trade, i) => {
        logger.info(`   ${i + 1}. ${trade.side} ${trade.amount.toFixed(2)} @ $${trade.price.toFixed(6)}`);
      });
    } else {
      logger.info('⚠️  No recent trades returned');
    }
    logger.info('');

    logger.info('═══════════════════════════════════════');
    logger.info('✅ ALL TESTS PASSED');
    logger.info(`${config.exchange.name.toUpperCase()} Exchange connection is working!`);
    logger.info('═══════════════════════════════════════');

  } catch (error) {
    logger.error('❌ Connection test failed:', error);
    process.exit(1);
  }
}

testConnection();
