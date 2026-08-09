import { logger } from '../utils/logger';
import { Balance, ExchangeService, Order, OrderBook, Ticker, Trade } from './exchange.types';

export class ShadowExchangeService implements ExchangeService {
  private readonly openShadowOrders = new Map<string, Order>();
  private readonly shadowOrderHistory = new Map<string, Order>();
  private readonly hiddenRealOrderIds = new Set<string>();
  private readonly knownRealOrders = new Map<string, Order>();
  private orderSequence = 0;

  constructor(private readonly delegate: ExchangeService) {}

  async getOrderBook(symbol: string): Promise<OrderBook> {
    return this.delegate.getOrderBook(symbol);
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.delegate.getTicker(symbol);
  }

  async getBalances(): Promise<Balance[]> {
    const balances = (await this.delegate.getBalances()).map((balance) => ({ ...balance }));
    const lockedByAsset = new Map<string, number>();

    for (const order of this.openShadowOrders.values()) {
      const [baseAsset, quoteAsset] = order.symbol.replace('/', '_').toUpperCase().split('_');
      const asset = order.side === 'BUY' ? quoteAsset : baseAsset;
      const locked = order.side === 'BUY' ? order.amount * order.price : order.amount;
      lockedByAsset.set(asset, (lockedByAsset.get(asset) || 0) + locked);
    }

    return balances.map((balance) => {
      const shadowLocked = lockedByAsset.get(balance.asset.toUpperCase()) || 0;
      return {
        ...balance,
        free: Math.max(balance.free - shadowLocked, 0),
        locked: balance.locked + shadowLocked,
        total: balance.total,
      };
    });
  }

  async getBalance(asset: string): Promise<Balance> {
    const balances = await this.getBalances();
    return balances.find((balance) => balance.asset === asset.toUpperCase()) || {
      asset: asset.toUpperCase(),
      free: 0,
      locked: 0,
      total: 0,
    };
  }

  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'LIMIT' | 'MARKET',
    amount: number,
    price?: number
  ): Promise<Order> {
    if (type !== 'LIMIT' || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || Number(price) <= 0) {
      throw new Error('Shadow mode requires a positive LIMIT order amount and price');
    }

    const order: Order = {
      orderId: `shadow-${Date.now()}-${++this.orderSequence}`,
      symbol,
      side,
      type,
      amount,
      price: Number(price),
      filled: 0,
      status: 'NEW',
      timestamp: Date.now(),
      fee: 0,
    };
    this.openShadowOrders.set(order.orderId, order);
    this.shadowOrderHistory.set(order.orderId, order);
    logger.info(
      `[AZBIT SHADOW] Would place ${side} ${amount.toFixed(8)} ${symbol} @ ${order.price.toExponential(4)} (notional=$${(amount * order.price).toFixed(4)})`
    );
    return { ...order };
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<boolean> {
    const shadowOrder = this.openShadowOrders.get(orderId);
    if (shadowOrder) {
      const canceledOrder: Order = { ...shadowOrder, status: 'CANCELED' };
      this.openShadowOrders.delete(orderId);
      this.shadowOrderHistory.set(orderId, canceledOrder);
      logger.info('[AZBIT SHADOW] Would cancel simulated order.');
      return true;
    }

    this.hiddenRealOrderIds.add(orderId);
    logger.info('[AZBIT SHADOW] Would cancel real exchange order; no request sent.');
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    const realOrders = await this.fetchRealOpenOrders(symbol);
    const visibleRealOrders = realOrders.filter((order) => !this.hiddenRealOrderIds.has(order.orderId));
    for (const order of visibleRealOrders) {
      this.hiddenRealOrderIds.add(order.orderId);
    }

    const shadowOrders = Array.from(this.openShadowOrders.values())
      .filter((order) => order.symbol === symbol);
    for (const order of shadowOrders) {
      this.openShadowOrders.delete(order.orderId);
      this.shadowOrderHistory.set(order.orderId, { ...order, status: 'CANCELED' });
    }

    const count = visibleRealOrders.length + shadowOrders.length;
    logger.info(`[AZBIT SHADOW] Would cancel ${count} order(s); no requests sent.`);
    return count;
  }

  async getOrder(symbol: string, orderId: string): Promise<Order> {
    const shadowOrder = this.shadowOrderHistory.get(orderId);
    if (shadowOrder) {
      return { ...shadowOrder };
    }

    const realOrder = this.knownRealOrders.get(orderId);
    if (this.hiddenRealOrderIds.has(orderId) && realOrder) {
      return { ...realOrder, status: 'CANCELED' };
    }
    return this.delegate.getOrder(symbol, orderId);
  }

  async getFinishedOrder(symbol: string, orderId: string): Promise<Order | null> {
    const shadowOrder = this.shadowOrderHistory.get(orderId);
    if (shadowOrder) {
      return shadowOrder.status === 'NEW' ? null : { ...shadowOrder };
    }

    const realOrder = this.knownRealOrders.get(orderId);
    if (this.hiddenRealOrderIds.has(orderId) && realOrder) {
      return { ...realOrder, status: 'CANCELED' };
    }
    return this.delegate.getFinishedOrder(symbol, orderId);
  }

  async getOpenOrders(symbol?: string, offset: number = 0, limit: number = 100): Promise<Order[]> {
    if (!symbol) {
      throw new Error('Shadow mode getOpenOrders requires a symbol');
    }

    const realOrders = await this.fetchRealOpenOrders(symbol);
    const visibleRealOrders = realOrders.filter((order) => !this.hiddenRealOrderIds.has(order.orderId));
    const shadowOrders = Array.from(this.openShadowOrders.values())
      .filter((order) => order.symbol === symbol);
    return [...visibleRealOrders, ...shadowOrders]
      .slice(Math.max(offset, 0), Math.max(offset, 0) + Math.max(limit, 1))
      .map((order) => ({ ...order }));
  }

  async getRecentTrades(symbol: string, limit: number = 50, orderId?: string): Promise<Trade[]> {
    if (orderId && this.shadowOrderHistory.has(orderId)) {
      return [];
    }
    return this.delegate.getRecentTrades(symbol, limit, orderId);
  }

  private async fetchRealOpenOrders(symbol: string): Promise<Order[]> {
    const orders = await this.delegate.getOpenOrders(symbol, 0, 100);
    for (const order of orders) {
      this.knownRealOrders.set(order.orderId, order);
    }
    return orders;
  }
}