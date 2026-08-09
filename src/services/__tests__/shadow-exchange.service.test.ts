jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
  },
}));

import { ExchangeService, Order } from '../exchange.types';
import { ShadowExchangeService } from '../shadow-exchange.service';

const createDelegate = (realOrders: Order[] = []): jest.Mocked<ExchangeService> => ({
  getOrderBook: jest.fn().mockResolvedValue({ bids: [], asks: [], timestamp: 1 }),
  getTicker: jest.fn().mockResolvedValue({
    symbol: 'EPWX_USDT', price: 1.49e-10, bid: 1.49e-10, ask: 9.999e-10,
    volume24h: 0, high24h: 0, low24h: 0,
  }),
  getBalances: jest.fn().mockResolvedValue([
    { asset: 'EPWX', free: 1_000_000_000, locked: 0, total: 1_000_000_000 },
    { asset: 'USDT', free: 50, locked: 0, total: 50 },
  ]),
  getBalance: jest.fn(),
  placeOrder: jest.fn(),
  cancelOrder: jest.fn(),
  cancelAllOrders: jest.fn(),
  getOrder: jest.fn(),
  getFinishedOrder: jest.fn(),
  getOpenOrders: jest.fn().mockResolvedValue(realOrders),
  getRecentTrades: jest.fn().mockResolvedValue([]),
});

describe('ShadowExchangeService', () => {
  it('simulates placement, balance locking, and cancellation without exchange writes', async () => {
    const delegate = createDelegate();
    const shadow = new ShadowExchangeService(delegate);

    const order = await shadow.placeOrder('EPWX_USDT', 'SELL', 'LIMIT', 500_000_000, 1.1e-9);
    const openOrders = await shadow.getOpenOrders('EPWX_USDT');
    const epwxBalance = await shadow.getBalance('EPWX');

    expect(openOrders).toEqual([order]);
    expect(epwxBalance).toMatchObject({ free: 500_000_000, locked: 500_000_000, total: 1_000_000_000 });
    expect(delegate.placeOrder).not.toHaveBeenCalled();

    await expect(shadow.cancelOrder('EPWX_USDT', order.orderId)).resolves.toBe(true);
    await expect(shadow.getOpenOrders('EPWX_USDT')).resolves.toEqual([]);
    await expect(shadow.getOrder('EPWX_USDT', order.orderId)).resolves.toMatchObject({ status: 'CANCELED' });
    expect(delegate.cancelOrder).not.toHaveBeenCalled();
  });

  it('virtually cancels and hides real orders without calling exchange cancellation', async () => {
    const realOrder: Order = {
      orderId: 'real-1', symbol: 'EPWX_USDT', side: 'SELL', type: 'LIMIT',
      amount: 1, price: 1, filled: 0, status: 'NEW', timestamp: 1, fee: 0,
    };
    const delegate = createDelegate([realOrder]);
    const shadow = new ShadowExchangeService(delegate);

    await expect(shadow.cancelAllOrders('EPWX_USDT')).resolves.toBe(1);
    await expect(shadow.getOpenOrders('EPWX_USDT')).resolves.toEqual([]);
    await expect(shadow.getOrder('EPWX_USDT', realOrder.orderId)).resolves.toMatchObject({ status: 'CANCELED' });
    expect(delegate.cancelAllOrders).not.toHaveBeenCalled();
    expect(delegate.cancelOrder).not.toHaveBeenCalled();
  });

  it('returns no fills for simulated orders and delegates public reads', async () => {
    const delegate = createDelegate();
    const shadow = new ShadowExchangeService(delegate);
    const order = await shadow.placeOrder('EPWX_USDT', 'BUY', 'LIMIT', 1_000_000_000, 1.49e-10);

    await expect(shadow.getRecentTrades('EPWX_USDT', 10, order.orderId)).resolves.toEqual([]);
    await expect(shadow.getTicker('EPWX_USDT')).resolves.toMatchObject({ bid: 1.49e-10 });
    expect(delegate.getRecentTrades).not.toHaveBeenCalled();
    expect(delegate.getTicker).toHaveBeenCalledWith('EPWX_USDT');
  });
});