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

export interface ExchangeService {
  getOrderBook(symbol: string): Promise<OrderBook>;
  getTicker(symbol: string): Promise<Ticker>;
  getBalances(): Promise<Balance[]>;
  getBalance(asset: string): Promise<Balance>;
  placeOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'LIMIT' | 'MARKET',
    amount: number,
    price?: number
  ): Promise<Order>;
  cancelOrder(symbol: string, orderId: string): Promise<boolean>;
  cancelAllOrders(symbol: string): Promise<number>;
  getOrder(symbol: string, orderId: string): Promise<Order>;
  getFinishedOrder(symbol: string, orderId: string): Promise<Order | null>;
  getOpenOrders(symbol?: string, offset?: number, limit?: number): Promise<Order[]>;
  getRecentTrades(symbol: string, limit?: number, orderId?: string): Promise<Trade[]>;
}
