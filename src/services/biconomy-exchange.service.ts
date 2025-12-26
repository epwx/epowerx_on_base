import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { config } from '../config';

export interface OrderBook {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  timestamp: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface Order {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price: number;
  amount: number;
  filled: number;
  status: 'NEW' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED';
  timestamp: number;
  fee: number;
}

export interface Ticker {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface Trade {
  tradeId: string;
  orderId: string;
  price: number;
  amount: number;
  side: 'BUY' | 'SELL';
  timestamp: number;
  fee: number;
}

/**
 * Biconomy Exchange API Service
 * Zero-fee market maker account integration
 */
export class BiconomyExchangeService {
  private client: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    this.apiKey = config.biconomyExchange.apiKey;
    this.apiSecret = config.biconomyExchange.apiSecret;

    this.client = axios.create({
      baseURL: config.biconomyExchange.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  private signRequest(params: any): string {
    // Sort parameters alphabetically and create query string
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');
    
    // Append secret_key to the string
    const signaturePayload = `${queryString}&secret_key=${this.apiSecret}`;
    
    // Generate MD5 hash and convert to uppercase
    return crypto
      .createHash('md5')
      .update(signaturePayload)
      .digest('hex')
      .toUpperCase();
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    try {
      const response = await this.client.get('/v1/depth', {
        params: { symbol: symbol.replace('/', '_').toUpperCase() },
      });

      logger.debug('Order book response:', response.data);

      // Handle empty order book
      const bids = response.data.bids || [];
      const asks = response.data.asks || [];

      return {
        bids: bids.map((b: any) => [parseFloat(b[0]), parseFloat(b[1])]),
        asks: asks.map((a: any) => [parseFloat(a[0]), parseFloat(a[1])]),
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('Failed to get order book:', error);
      throw error;
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    try {
      logger.debug(`[getTicker] Fetching ticker for ${symbol}`);
      const response = await this.client.get('/v1/tickers');

      logger.debug(`[getTicker] Got response, status: ${response.status}`);
      const data = response.data;
      
      logger.debug(`[getTicker] Response data type: ${typeof data}, has ticker? ${!!data?.ticker}`);
      
      // API returns array of tickers, find the matching symbol
      const targetSymbol = symbol.replace('/', '_').toUpperCase();
      const ticker = data.ticker?.find((t: any) => t.symbol === targetSymbol);
      
      if (!ticker) {
        logger.error(`[getTicker] Symbol ${targetSymbol} not found in ticker data. Available symbols: ${data.ticker?.map((t: any) => t.symbol).join(', ')}`);
        throw new Error(`Symbol ${symbol} not found in ticker data`);
      }

      logger.debug(`[getTicker] Found ticker: ${JSON.stringify(ticker)}`);

      return {
        symbol,
        price: parseFloat(ticker.last),
        bid: parseFloat(ticker.buy),
        ask: parseFloat(ticker.sell),
        volume24h: parseFloat(ticker.vol),
        high24h: parseFloat(ticker.high),
        low24h: parseFloat(ticker.low),
      };
    } catch (error) {
      logger.error(`[getTicker] Error fetching ticker for ${symbol}:`, error);
      throw error;
    }
  }

  async getBalances(): Promise<Balance[]> {
    try {
      const params: any = { 
        api_key: this.apiKey,
      };
      const signature = this.signRequest(params);
      params.sign = signature;

      logger.debug('Getting balances with params:', params);

      const urlParams = new URLSearchParams(params);
      const response = await this.client.post('/api/v1/private/user', urlParams.toString());

      logger.debug('Balance response:', response.data);

      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to get balances');
      }

      const result = response.data.result;
      const balances: Balance[] = [];

      for (const [asset, data] of Object.entries(result)) {
        const assetData = data as any;
        balances.push({
          asset,
          free: parseFloat(assetData.available),
          locked: parseFloat(assetData.freeze),
          total: parseFloat(assetData.available) + parseFloat(assetData.freeze),
        });
      }

      return balances;
    } catch (error) {
      logger.error('Failed to get balances:', error);
      throw error;
    }
  }

  async getBalance(asset: string): Promise<Balance> {
    const balances = await this.getBalances();
    const balance = balances.find(b => b.asset === asset.toUpperCase());
    
    if (!balance) {
      return { asset, free: 0, locked: 0, total: 0 };
    }
    
    return balance;
  }

  async placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'LIMIT' | 'MARKET',
    amount: number,
    price?: number
  ): Promise<Order> {
    try {
      const path = type === 'LIMIT' ? '/v1/private/trade/limit' : '/v1/private/trade/market';
      // Format amount - different exchanges have different precision requirements
      // For EPWX (large quantities), use integers. For small amounts, use appropriate decimals.
      const amountStr = amount >= 1 ? Math.floor(amount).toString() : amount.toFixed(8);
      
      const params: any = {
        api_key: this.apiKey,
        market: symbol.replace('/', '_').toUpperCase(),
        side: side === 'SELL' ? '1' : '2', // 1=ask/sell, 2=bid/buy
        amount: amountStr,
      };

      if (type === 'LIMIT' && price) {
        // For ultra-low prices, need more decimal places
        // Detect how many decimals needed to represent the price accurately
        let priceStr: string;
        if (price < 0.00000001) {
          // For very small prices, convert to fixed with enough decimals
          // Find number of leading zeros after decimal point
          const priceScientific = price.toExponential();
          const exponent = parseInt(priceScientific.split('e')[1]);
          const decimals = Math.abs(exponent) + 3; // Add extra digits for precision
          priceStr = price.toFixed(decimals);
        } else {
          priceStr = price.toFixed(8);
        }
        params.price = priceStr;
        logger.info(`Placing ${side} order: amount=${amountStr}, price=${priceStr} (raw price=${price})`);
      } else if (type === 'MARKET') {
        // Do NOT include price for MARKET orders
        logger.info(`Placing ${side} MARKET order: amount=${amountStr}`);
      }

      const signature = this.signRequest(params);
      params.sign = signature;

      const urlParams = new URLSearchParams(params);
      logger.debug(`Sending POST request to ${path} with params:`, { ...params, api_key: '***', sign: '***' });
      
      const response = await this.client.post(path, urlParams.toString());
      const data = response.data;

      logger.debug(`Order response:`, data);

      if (data.code !== 0) {
        throw new Error(data.message || 'Failed to place order');
      }

      logger.info(`✅ Order placed successfully: ${side} ${amount} ${symbol} @ ${price || 'MARKET'} [ID: ${data.result.id}]`);

      return {
        orderId: data.result.id.toString(),
        symbol,
        side,
        type,
        price: parseFloat(data.result.price || '0'),
        amount: parseFloat(data.result.amount),
        filled: parseFloat(data.result.deal_stock || '0'),
        status: 'NEW',
        timestamp: Date.now(),
        fee: 0, // Zero fee for MM account
      };
    } catch (error) {
      logger.error(`Failed to place ${side} order for ${symbol}:`, error);
      throw error;
    }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<boolean> {
    try {
      const params: any = {
        api_key: this.apiKey,
        market: symbol.replace('/', '_').toUpperCase(),
        order_id: orderId,
      };

      const signature = this.signRequest(params);
      params.sign = signature;

      const urlParams = new URLSearchParams(params);
      const response = await this.client.post('/v1/private/trade/cancel', urlParams.toString());
      
      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to cancel order');
      }

      logger.debug(`Order cancelled: ${orderId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to cancel order ${orderId}:`, error);
      throw error;
    }
  }

  async cancelAllOrders(symbol?: string): Promise<number> {
    try {
      if (!symbol) {
        throw new Error('Symbol is required for cancel all orders');
      }

      const params: any = {
        api_key: this.apiKey,
        market: symbol.replace('/', '_').toUpperCase(),
      };

      const signature = this.signRequest(params);
      params.sign = signature;

      const urlParams = new URLSearchParams(params);
      const response = await this.client.post('/v1/private/trade/cancel_all', urlParams.toString());
      
      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to cancel all orders');
      }

      const count = response.data.result?.cancelled?.length || 0;
      logger.info(`Cancelled ${count} orders`);
      return count;
    } catch (error) {
      logger.error('Failed to cancel all orders:', error);
      throw error;
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<Order> {
    try {
      const params: any = {
        api_key: this.apiKey,
        market: symbol.replace('/', '_').toUpperCase(),
        order_id: orderId,
      };

      const signature = this.signRequest(params);
      params.sign = signature;

      const urlParams = new URLSearchParams(params);
      const response = await this.client.post('/api/v1/private/order/pending/detail', urlParams.toString());

      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to get order');
      }

      const data = response.data.result;
      
      // Order might have been filled/canceled and removed from pending
      if (!data || !data.id) {
        throw new Error('Order not found or already completed');
      }

      return {
        orderId: data.id.toString(),
        symbol,
        side: data.side === 1 ? 'SELL' : 'BUY',
        type: data.type === 1 ? 'LIMIT' : 'MARKET',
        price: parseFloat(data.price),
        amount: parseFloat(data.amount),
        filled: parseFloat(data.deal_stock),
        status: 'NEW',
        timestamp: data.ctime * 1000,
        fee: 0,
      };
    } catch (error) {
      logger.error(`Failed to get order ${orderId}:`, error);
      throw error;
    }
  }

  async getOpenOrders(symbol?: string, offset: number = 0, limit: number = 10): Promise<Order[]> {
    // Biconomy expects 'market' param, not 'symbol'
    const market = symbol ? symbol.replace('/', '_').toUpperCase() : undefined;
    if (!market) throw new Error('Market (symbol) is required for getOpenOrders');
    const params: Record<string, any> = {
      api_key: this.apiKey,
      market,
      offset,
      limit,
    };
    // Signature: all params sorted alphabetically, joined as key=value, then &secret_key=... and MD5/uppercase
    const sign = this.signRequest(params);
    params.sign = sign;
    logger.info(`[getOpenOrders] Params: ${JSON.stringify(params)}`);
    try {
      const urlParams = new URLSearchParams(params);
      const response = await this.client.post('/api/v1/private/order/pending', urlParams.toString(), {
        headers: {
          'X-API-KEY': this.apiKey,
          'X-SITE-ID': '127',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      logger.debug(`[getOpenOrders] Response: ${JSON.stringify(response.data)}`);
      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to get open orders');
      }
      // Map API response to Order[]
      const records = response.data.result?.records || [];
      return records.map((order: any) => ({
        orderId: order.id.toString(),
        symbol: order.market,
        side: order.side === 1 ? 'SELL' : 'BUY',
        type: order.type === 1 ? 'LIMIT' : 'MARKET',
        price: parseFloat(order.price),
        amount: parseFloat(order.amount),
        filled: parseFloat(order.deal_stock),
        status: 'NEW',
        timestamp: (order.ctime || 0) * 1000,
        fee: parseFloat(order.deal_fee || '0'),
      }));
    } catch (error) {
      logger.error(`[getOpenOrders] Error:`, error);
      throw error;
    }
  }

  async getRecentTrades(symbol: string, limit: number = 50, orderId?: string): Promise<Trade[]> {
    try {
      // This endpoint requires an order_id parameter, so return empty if not provided
      if (!orderId) {
        logger.debug('No order ID provided for getRecentTrades, returning empty array');
        return [];
      }

      const params: any = {
        api_key: this.apiKey,
        order_id: orderId,
        offset: 0,
        limit: limit,
      };

      const signature = this.signRequest(params);
      params.sign = signature;

      const urlParams = new URLSearchParams(params);
      const response = await this.client.post('/v1/private/order/deals', urlParams.toString());

      if (response.data.code !== 0) {
        throw new Error(response.data.message || 'Failed to get recent trades');
      }

      return response.data.result.records.map((trade: any) => ({
        tradeId: trade.id.toString(),
        orderId: trade.deal_order_id.toString(),
        price: parseFloat(trade.price),
        amount: parseFloat(trade.amount),
        side: trade.role === 1 ? 'SELL' : 'BUY',
        timestamp: trade.time * 1000,
        fee: parseFloat(trade.fee),
      }));
    } catch (error) {
      logger.error('Failed to get recent trades:', error);
      throw error;
    }
  }

  private handleError(error: any, context: string): never {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.message || error.message;
      logger.error(`[Biconomy Exchange] ${context}: ${message}`, {
        status: error.response?.status,
        data: error.response?.data,
      });
      throw new Error(`${context}: ${message}`);
    }
    logger.error(`[Biconomy Exchange] ${context}:`, error);
    throw error;
  }
}
