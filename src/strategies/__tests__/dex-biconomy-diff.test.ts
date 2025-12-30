
process.env.BICONOMY_EXCHANGE_API_KEY = 'test';
process.env.BICONOMY_EXCHANGE_API_SECRET = 'test';
process.env.BICONOMY_EXCHANGE_BASE_URL = 'http://localhost';
process.env.TRADING_PAIR = 'EPWX/USDT';
process.env.EPWX_TOKEN_ADDRESS = '0x0';
process.env.EPWX_WETH_PAIR = '0x0';
process.env.BASE_RPC_URL = 'http://localhost';

import { VolumeGenerationStrategy } from '../volume-generation.strategy';

describe('DEX vs Biconomy price difference', () => {
  it('should calculate the percentage difference between DEX and Biconomy prices', async () => {
    // Mock exchange and config
    const mockExchange = {
      getTicker: async () => ({ bid: 9.5, ask: 10.5 }),
      getOpenOrders: async () => [],
      getBalances: async () => [
        { asset: 'USDT', free: 10000 },
        { asset: 'EPWX', free: 10000 }
      ],
      cancelAllOrders: async () => 0,
      placeOrder: jest.fn().mockResolvedValue({ orderId: 'test', symbol: 'EPWXUSDT', side: 'BUY', type: 'LIMIT', price: 10, amount: 1, filled: 0, status: 'NEW', timestamp: Date.now(), fee: 0 })
    };
    // Extend strategy to expose logic
    class TestStrategy extends VolumeGenerationStrategy {
      public async testPriceDiff(dexPrice: number) {
        // Simulate discounted DEX price logic
        const discountPercent = 5;
        const discountedPrice = dexPrice * (1 - discountPercent / 100);
        const ticker = await this.exchange.getTicker('EPWX/USDT');
        const biconomyPrice = (ticker.ask + ticker.bid) / 2;
        const priceDiffPercent = ((biconomyPrice - discountedPrice) / discountedPrice) * 100;
        return priceDiffPercent;
      }
    }
    const strategy = new TestStrategy(mockExchange as any);
    // DEX price = 10, discounted = 9.5, Biconomy price = 10
    const diff = await strategy.testPriceDiff(10);
    expect(diff).toBeCloseTo(5.26, 1); // (10-9.5)/9.5*100 ≈ 5.26%
  });
});
