import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { logger } from '../utils/logger';
import { config } from '../config';
import { Balance, ExchangeService, Order, OrderBook, Ticker, Trade } from './exchange.types';

type AzbitPairData = {
  pair?: {
    code?: string;
    dgp?: number;
    dgam?: number;
    mos?: number | null;
    mkf?: number;
    tkf?: number;
  };
  pr?: number | null;
  qv?: number;
  h?: number | null;
  l?: number | null;
};

type AzbitOrderBookLevel = {
  isBid?: boolean;
  price?: number;
  amount?: number;
};

type AzbitOrderViewModel = {
  id?: string;
  isBid?: boolean;
  price?: number;
  initialAmount?: number;
  amount?: number;
  amountExecuted?: number;
  isCanceled?: boolean;
  status?: string;
  currencyPairCode?: string;
  date?: string;
};

type AzbitDeal = {
  id?: string;
  orderId?: string;
  price?: number;
  volume?: number;
  isBuy?: boolean;
  dealDateUtc?: string;
};

export class AzbitExchangeService implements ExchangeService {
  private readonly client: AxiosInstance;
  private readonly accessToken: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly readOnly: boolean;

  constructor() {
    this.accessToken = config.azbitExchange.accessToken;
    this.apiKey = config.azbitExchange.apiKey;
    this.apiSecret = config.azbitExchange.apiSecret;
    this.readOnly = config.azbitExchange.readOnly;

    this.client = axios.create({
      baseURL: config.azbitExchange.baseUrl,
      timeout: 30000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.replace('/', '_').toUpperCase();
  }

  private requireWritable(action: string): void {
    if (this.readOnly) {
      throw new Error(`AZBIT_READ_ONLY=true; refusing ${action}`);
    }
  }

  private requirePrivateAuth(action: string): { token?: string; apiKey?: string; apiSecret?: string } {
    if (this.accessToken) {
      return { token: this.accessToken };
    }

    if (this.apiKey && this.apiSecret) {
      return {
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
      };
    }

    throw new Error(
      `Azbit private auth is required to ${action}. Set AZBIT_ACCESS_TOKEN or AZBIT_API_KEY and AZBIT_API_SECRET.`
    );
  }

  private withAuth(cfg: AxiosRequestConfig): AxiosRequestConfig {
    const auth = this.requirePrivateAuth('call private Azbit endpoints');
    const headers: Record<string, string> = {
      ...((cfg.headers || {}) as Record<string, string>),
    };
    const params: Record<string, string> = {
      ...((cfg.params || {}) as Record<string, string>),
    };

    if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
      headers.access_token = auth.token;
      params.access_token = auth.token;
    }

    if (auth.apiKey && auth.apiSecret) {
      headers.publicKey = auth.apiKey;
      headers.privateKey = auth.apiSecret;
      headers['X-API-KEY'] = auth.apiKey;
      params.publicKey = auth.apiKey;
      params.privateKey = auth.apiSecret;
    }

    return {
      ...cfg,
      headers,
      params,
    };
  }

  private async getPairData(symbol: string): Promise<AzbitPairData | undefined> {
    const market = this.normalizeSymbol(symbol);
    const response = await this.client.get<AzbitPairData[]>('/api/currency-pairs/price-and-volume/v2');
    return response.data.find((row: AzbitPairData) => row?.pair?.code?.toUpperCase() === market);
  }

  private mapOrder(symbol: string, input: AzbitOrderViewModel): Order {
    const initialAmount = Number(input.initialAmount ?? input.amount ?? 0);
    const availableAmount = Number(input.amount ?? 0);
    const filled = Number(input.amountExecuted ?? Math.max(initialAmount - availableAmount, 0));
    const statusText = String(input.status || '').toUpperCase();

    let status: Order['status'] = 'NEW';
    if (input.isCanceled || statusText.includes('CANCEL')) {
      status = 'CANCELED';
    } else if (statusText.includes('FILL') || statusText.includes('DONE') || statusText.includes('COMPLETE')) {
      status = 'FILLED';
    } else if (filled > 0) {
      status = 'PARTIALLY_FILLED';
    }

    return {
      orderId: String(input.id || ''),
      symbol,
      side: input.isBid ? 'BUY' : 'SELL',
      type: 'LIMIT',
      price: Number(input.price || 0),
      amount: initialAmount,
      filled,
      status,
      timestamp: input.date ? Date.parse(input.date) : Date.now(),
      fee: 0,
    };
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    const market = this.normalizeSymbol(symbol);
    const response = await this.client.get<AzbitOrderBookLevel[]>(`/api/orders/book/${market}`);
    const rows = Array.isArray(response.data) ? response.data : [];

    const bids: Array<[number, number]> = [];
    const asks: Array<[number, number]> = [];

    for (const row of rows) {
      const price = Number(row?.price || 0);
      const amount = Number(row?.amount || 0);
      if (!Number.isFinite(price) || !Number.isFinite(amount) || price <= 0 || amount <= 0) {
        continue;
      }

      if (row?.isBid) {
        bids.push([price, amount]);
      } else {
        asks.push([price, amount]);
      }
    }

    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);

    return {
      bids,
      asks,
      timestamp: Date.now(),
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const market = this.normalizeSymbol(symbol);
    const pairData = await this.getPairData(market);

    if (!pairData) {
      throw new Error(`Azbit pair not found: ${market}`);
    }

    const orderBook = await this.getOrderBook(market);
    const bid = orderBook.bids[0]?.[0] || 0;
    const ask = orderBook.asks[0]?.[0] || 0;
    const last = Number(pairData.pr || 0);

    return {
      symbol,
      price: last,
      bid,
      ask,
      volume24h: Number(pairData.qv || 0),
      high24h: Number(pairData.h || 0),
      low24h: Number(pairData.l || 0),
    };
  }

  async getBalances(): Promise<Balance[]> {
    const response = await this.client.get<any>('/api/users/balances', this.withAuth({}));
    const balances = Array.isArray(response.data?.balances) ? response.data.balances : [];
    const blocked = Array.isArray(response.data?.balancesBlockedInOrder)
      ? response.data.balancesBlockedInOrder
      : [];

    const blockedByAsset = new Map<string, number>();
    for (const row of blocked) {
      const asset = String(row?.currencyCode || '').toUpperCase();
      if (!asset) {
        continue;
      }
      blockedByAsset.set(asset, Number(row?.amount || 0));
    }

    return balances.map((row: any) => {
      const asset = String(row?.currencyCode || '').toUpperCase();
      const free = Number(row?.amount || 0);
      const locked = Number(blockedByAsset.get(asset) || 0);
      return {
        asset,
        free,
        locked,
        total: free + locked,
      };
    });
  }

  async getBalance(asset: string): Promise<Balance> {
    const balances = await this.getBalances();
    const balance = balances.find((entry) => entry.asset === asset.toUpperCase());

    return (
      balance || {
        asset: asset.toUpperCase(),
        free: 0,
        locked: 0,
        total: 0,
      }
    );
  }

  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'LIMIT' | 'MARKET',
    amount: number,
    price?: number
  ): Promise<Order> {
    this.requireWritable('place orders');

    const market = this.normalizeSymbol(symbol);
    const pairData = await this.getPairData(market);
    if (!pairData) {
      throw new Error(`Azbit pair not found: ${market}`);
    }

    const amountDigits = Math.max(0, Number(pairData.pair?.dgam ?? 8));
    const priceDigits = Math.max(0, Number(pairData.pair?.dgp ?? 8));
    const minimumOrderSize = Number(pairData.pair?.mos ?? 0);
    const normalizedAmount = Number(amount.toFixed(Math.min(amountDigits, 14)));

    if (minimumOrderSize > 0 && normalizedAmount < minimumOrderSize) {
      throw new Error(
        `Azbit minimum order size check failed: amount=${normalizedAmount}, minimumOrderSize=${minimumOrderSize}`
      );
    }

    const requestPrice = type === 'MARKET' ? 0 : Number((price || 0).toFixed(Math.min(priceDigits, 14)));
    if (type === 'LIMIT' && requestPrice <= 0) {
      throw new Error('Azbit limit order requires a positive price');
    }

    const payload = {
      isBid: side === 'BUY',
      currencyPairCode: market,
      amount: normalizedAmount,
      price: requestPrice,
      isMarket: type === 'MARKET',
    };

    const response = await this.client.post<any>('/api/orders', payload, this.withAuth({}));
    const responseOrderId = String(response.data?.id || response.data?.orderId || '');

    return {
      orderId: responseOrderId || `azbit-${Date.now()}`,
      symbol,
      side,
      type,
      price: requestPrice,
      amount: normalizedAmount,
      filled: 0,
      status: 'NEW',
      timestamp: Date.now(),
      fee: 0,
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    this.requireWritable('cancel orders');
    await this.client.delete(`/api/orders/${orderId}`, this.withAuth({}));
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    this.requireWritable('cancel all orders');

    const market = this.normalizeSymbol(symbol);
    try {
      await this.client.delete(`/api/orders/users/all/${market}`, this.withAuth({}));
      return 0;
    } catch (error) {
      logger.warn('Azbit bulk cancel endpoint failed, falling back to per-order cancel', error as any);
      const openOrders = await this.getOpenOrders(symbol);
      let cancelled = 0;
      for (const order of openOrders) {
        try {
          await this.cancelOrder(symbol, order.orderId);
          cancelled++;
        } catch (cancelError) {
          logger.warn(`Failed to cancel Azbit order ${order.orderId}`, cancelError as any);
        }
      }
      return cancelled;
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<Order> {
    const openOrders = await this.getOpenOrders(symbol);
    const openOrder = openOrders.find((order) => order.orderId === orderId);
    if (openOrder) {
      return openOrder;
    }

    const finished = await this.getFinishedOrder(symbol, orderId);
    if (finished) {
      return finished;
    }

    throw new Error(`Azbit order not found: ${orderId}`);
  }

  async getFinishedOrder(symbol: string, orderId: string): Promise<Order | null> {
    try {
      const market = this.normalizeSymbol(symbol);
      const response = await this.client.get<AzbitOrderViewModel[]>('/api/orders/user-order-history',
        this.withAuth({
          params: {
            currencyPairCode: market,
            pageNumber: 1,
            pageSize: 200,
          },
        })
      );

      const rows = Array.isArray(response.data) ? response.data : [];
      const row = rows.find((entry) => String(entry?.id || '') === orderId);
      if (!row) {
        return null;
      }

      const mapped = this.mapOrder(symbol, row);
      if (mapped.status === 'NEW') {
        mapped.status = mapped.filled > 0 ? 'PARTIALLY_FILLED' : 'CANCELED';
      }
      return mapped;
    } catch {
      return null;
    }
  }

  async getOpenOrders(symbol?: string, offset: number = 0, limit: number = 100): Promise<Order[]> {
    const market = symbol ? this.normalizeSymbol(symbol) : '';
    if (!market) {
      throw new Error('Azbit getOpenOrders requires a symbol');
    }

    const pageNumber = Math.floor(Math.max(offset, 0) / Math.max(limit, 1)) + 1;

    const response = await this.client.get<AzbitOrderViewModel[]>(`/api/orders/users/${market}`,
      this.withAuth({
        params: {
          status: 'active',
          pageNumber,
          pageSize: Math.max(1, Math.min(limit, 200)),
        },
      })
    );

    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map((row) => this.mapOrder(symbol || market, row));
  }

  async getRecentTrades(symbol: string, limit: number = 50, orderId?: string): Promise<Trade[]> {
    const market = this.normalizeSymbol(symbol);
    const response = await this.client.get<AzbitDeal[]>(`/api/deals/main/${market}`,
      {
        params: {
          pageSize: Math.max(1, Math.min(limit, 200)),
        },
      }
    );

    const rows = Array.isArray(response.data) ? response.data : [];
    const filtered = orderId
      ? rows.filter((row) => String(row?.orderId || '') === orderId)
      : rows;

    return filtered.map((trade) => ({
      tradeId: String(trade?.id || ''),
      orderId: String(trade?.orderId || ''),
      price: Number(trade?.price || 0),
      amount: Number(trade?.volume || 0),
      side: trade?.isBuy ? 'BUY' : 'SELL',
      timestamp: trade?.dealDateUtc ? Date.parse(trade.dealDateUtc) : Date.now(),
      fee: 0,
    }));
  }
}
