jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      get: jest.fn(),
      request: jest.fn(),
    })),
  },
}));

jest.mock('../../config', () => ({
  config: {
    azbitExchange: {
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseUrl: 'https://data.azbit.com',
      readOnly: false,
    },
    runtime: {
      logFilePrefix: '',
    },
    exchange: {
      name: 'azbit',
    },
    logLevel: 'error',
  },
}));

import { AzbitExchangeService } from '../azbit-exchange.service';

describe('AzbitExchangeService order mapping', () => {
  const mapOrder = (input: Record<string, unknown>) => {
    const service = new AzbitExchangeService();
    return (service as any).mapOrder('EPWX_USDT', input);
  };

  it('keeps an explicitly partial order partially filled', () => {
    const order = mapOrder({
      id: 'partial-1',
      isBid: true,
      price: 1.49e-10,
      initialAmount: 1_000_000_000,
      amount: 691_566_535.5731438,
      amountExecuted: 691_566_535.5731438,
      status: 'PartiallyCompleted',
    });

    expect(order.filled).toBeCloseTo(308_433_464.4268562, 6);
    expect(order.status).toBe('PARTIALLY_FILLED');
  });

  it('keeps a Created order open when Azbit reports zero amount fields', () => {
    const order = mapOrder({
      id: 'created-1',
      isBid: false,
      price: 1.1e-9,
      initialAmount: 1_000_000_000,
      amount: 0,
      amountExecuted: 0,
      status: 'Created',
    });

    expect(order.filled).toBe(0);
    expect(order.status).toBe('NEW');
  });

  it('marks an order filled when its executed amount reaches its initial amount', () => {
    const order = mapOrder({
      id: 'filled-1',
      isBid: false,
      price: 1.49e-10,
      initialAmount: 100,
      amount: 0,
      amountExecuted: 100,
    });

    expect(order.filled).toBe(100);
    expect(order.status).toBe('FILLED');
  });

  it('does not report an active remainder as filled from ambiguous status text', () => {
    const order = mapOrder({
      id: 'ambiguous-1',
      isBid: false,
      price: 1.49e-10,
      initialAmount: 100,
      amount: 75,
      status: 'FILLING',
    });

    expect(order.filled).toBe(25);
    expect(order.status).toBe('PARTIALLY_FILLED');
  });

  it('reconciles executed amount from nested order deals', () => {
    const order = mapOrder({
      id: 'nested-deals-1',
      isBid: true,
      price: 1.49e-10,
      initialAmount: 100,
      amount: 100,
      amountExecuted: 0,
      deals: [{ volume: 30 }, { volume: 20 }],
    });

    expect(order.filled).toBe(50);
    expect(order.status).toBe('PARTIALLY_FILLED');
  });
});

describe('AzbitExchangeService private API behavior', () => {
  const createService = () => {
    const service = new AzbitExchangeService();
    const client = (service as any).client;
    return { service, client };
  };

  it('uses authenticated user deals and maps the account side', async () => {
    const { service, client } = createService();
    client.request.mockResolvedValue({
      data: [{
        id: 'deal-1',
        orderId: 'order-1',
        price: 1.49e-10,
        volume: 25,
        isBuy: false,
        isUserBuyer: true,
        dealDateUtc: '2026-08-09T00:00:00Z',
      }],
    });

    const trades = await service.getRecentTrades('EPWX_USDT', 10, 'order-1');

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ orderId: 'order-1', side: 'BUY', amount: 25 });
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: expect.stringContaining('/api/user/deals?'),
    }));
  });

  it('rejects orders below the pair minimum quote amount', async () => {
    const { service, client } = createService();
    client.get.mockResolvedValue({
      data: [{
        code: 'EPWX_USDT',
        digitsPrice: 13,
        digitsAmount: 13,
        minQuoteAmount: 0.5,
      }],
    });

    await expect(service.placeOrder('EPWX_USDT', 'BUY', 'LIMIT', 2_000_000_000, 1.49e-10))
      .rejects.toThrow('minimum quote amount');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('returns the number of orders accepted by bulk cancellation', async () => {
    const { service, client } = createService();
    client.request
      .mockResolvedValueOnce({
        data: [
          { id: 'order-1', initialAmount: 1, amount: 1, status: 'active' },
          { id: 'order-2', initialAmount: 1, amount: 1, status: 'active' },
        ],
      })
      .mockResolvedValueOnce({ data: {} });

    await expect(service.cancelAllOrders('EPWX_USDT')).resolves.toBe(2);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('excludes terminal rows returned by the active-orders endpoint', async () => {
    const { service, client } = createService();
    client.request.mockResolvedValue({
      data: [
        { id: 'active-1', initialAmount: 10, amount: 0, amountExecuted: 0, status: 'Created' },
        { id: 'partial-1', initialAmount: 10, amount: 6, amountExecuted: 6, status: 'PartiallyCompleted' },
        { id: 'filled-1', initialAmount: 10, amount: 0, amountExecuted: 10, status: 'filled' },
        { id: 'canceled-1', initialAmount: 10, amount: 10, isCanceled: true },
      ],
    });

    const orders = await service.getOpenOrders('EPWX_USDT');

    expect(orders.map((order) => order.orderId)).toEqual(['active-1', 'partial-1']);
  });
});