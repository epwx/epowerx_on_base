# Biconomy Exchange API Documentation

## Base URL
```
https://api.biconomy.exchange
```

## Authentication

All authenticated endpoints require:
- `X-API-KEY` header with your API key
- Request signature using HMAC-SHA256

### Signature Generation

```typescript
const timestamp = Date.now();
const params = { symbol: 'EPWXUSDT', side: 'BUY', timestamp };
const queryString = Object.keys(params)
  .sort()
  .map(key => `${key}=${params[key]}`)
  .join('&');

const signaturePayload = `${timestamp}${queryString}`;
const signature = crypto
  .createHmac('sha256', apiSecret)
  .update(signaturePayload)
  .digest('hex');
```

## Public Endpoints

### Get Ticker
```
GET /api/v1/ticker
```

**Parameters:**
- `symbol` (string): Trading pair (e.g., `EPWXUSDT`)

**Response:**
```json
{
  "symbol": "EPWXUSDT",
  "lastPrice": "0.393000",
  "bidPrice": "0.392500",
  "askPrice": "0.393500",
  "volume": "1234567.89",
  "highPrice": "0.395000",
  "lowPrice": "0.390000"
}
```

### Get Order Book
```
GET /api/v1/orderbook
```

**Parameters:**
- `symbol` (string): Trading pair

**Response:**
```json
{
  "bids": [
    { "price": "0.392500", "amount": "1000.00" },
    { "price": "0.392000", "amount": "2000.00" }
  ],
  "asks": [
    { "price": "0.393500", "amount": "1500.00" },
    { "price": "0.394000", "amount": "1800.00" }
  ]
}
```

## Private Endpoints

### Get Account Balances
```
GET /api/v1/account/balances
```

**Parameters:**
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
{
  "balances": [
    {
      "asset": "EPWX",
      "free": "10000.00000000",
      "locked": "125.50000000"
    },
    {
      "asset": "USDT",
      "free": "50000.00000000",
      "locked": "1050.25000000"
    }
  ]
}
```

### Place Order
```
POST /api/v1/order
```

**Parameters:**
- `symbol` (string): Trading pair (e.g., `EPWXUSDT`)
- `side` (string): `BUY` or `SELL`
- `type` (string): `LIMIT` or `MARKET`
- `quantity` (string): Order amount
- `price` (string): Limit price (required for LIMIT orders)
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
{
  "orderId": "123456789",
  "symbol": "EPWXUSDT",
  "side": "BUY",
  "type": "LIMIT",
  "price": "0.392500",
  "origQty": "100.00000000",
  "executedQty": "0.00000000",
  "status": "NEW",
  "transactTime": 1638360000000
}
```

### Cancel Order
```
DELETE /api/v1/order
```

**Parameters:**
- `symbol` (string): Trading pair
- `orderId` (string): Order ID to cancel
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
{
  "orderId": "123456789",
  "status": "CANCELED"
}
```

### Cancel All Orders
```
DELETE /api/v1/orders
```

**Parameters:**
- `symbol` (string, optional): Trading pair (if omitted, cancels all pairs)
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
{
  "cancelledCount": 15
}
```

### Get Order Status
```
GET /api/v1/order
```

**Parameters:**
- `symbol` (string): Trading pair
- `orderId` (string): Order ID
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
{
  "orderId": "123456789",
  "symbol": "EPWXUSDT",
  "side": "BUY",
  "type": "LIMIT",
  "price": "0.392500",
  "origQty": "100.00000000",
  "executedQty": "100.00000000",
  "status": "FILLED",
  "time": 1638360000000
}
```

### Get Open Orders
```
GET /api/v1/orders/open
```

**Parameters:**
- `symbol` (string, optional): Trading pair filter
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
[
  {
    "orderId": "123456789",
    "symbol": "EPWXUSDT",
    "side": "BUY",
    "type": "LIMIT",
    "price": "0.392500",
    "origQty": "100.00000000",
    "executedQty": "50.00000000",
    "status": "PARTIALLY_FILLED",
    "time": 1638360000000
  }
]
```

### Get Trade History
```
GET /api/v1/trades/history
```

**Parameters:**
- `symbol` (string): Trading pair
- `limit` (number): Number of trades (default: 50, max: 500)
- `timestamp` (number): Current timestamp
- `signature` (string): Request signature

**Response:**
```json
[
  {
    "id": "987654321",
    "orderId": "123456789",
    "symbol": "EPWXUSDT",
    "price": "0.392500",
    "qty": "100.00000000",
    "side": "BUY",
    "time": 1638360000000
  }
]
```

## Order Status Values

- `NEW`: Order accepted by engine
- `PARTIALLY_FILLED`: Order partially filled
- `FILLED`: Order completely filled
- `CANCELED`: Order canceled by user
- `REJECTED`: Order rejected by engine
- `EXPIRED`: Order expired

## Rate Limits

- **Public endpoints**: 20 requests/second
- **Private endpoints**: 10 requests/second
- **Order placement**: 5 orders/second

## Error Codes

| Code | Message | Description |
|------|---------|-------------|
| 400 | Bad Request | Invalid parameters |
| 401 | Unauthorized | Invalid API key or signature |
| 403 | Forbidden | IP not whitelisted or insufficient permissions |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Exchange system error |
| 503 | Service Unavailable | System maintenance |

## Error Response Format

```json
{
  "code": 400,
  "message": "Invalid symbol"
}
```

## Trading Rules

### Symbol Information
- **EPWX/USDT**:
  - Min Order Size: 10 EPWX
  - Max Order Size: 100,000 EPWX
  - Price Precision: 6 decimals
  - Quantity Precision: 8 decimals

### Market Maker Benefits
- **Zero Fees**: 0% maker and taker fees for MM accounts
- **Higher Limits**: Increased rate limits
- **Priority Matching**: Orders matched with priority

## WebSocket API (Optional)

For real-time data, connect to:
```
wss://stream.biconomy.exchange/ws
```

### Subscribe to Ticker
```json
{
  "method": "SUBSCRIBE",
  "params": ["epwxusdt@ticker"]
}
```

### Subscribe to Order Book
```json
{
  "method": "SUBSCRIBE",
  "params": ["epwxusdt@depth"]
}
```

### Subscribe to Trades
```json
{
  "method": "SUBSCRIBE",
  "params": ["epwxusdt@trade"]
}
```

## Best Practices

1. **Cache ticker data**: Don't request on every order
2. **Batch operations**: Cancel multiple orders in one request
3. **Handle rate limits**: Implement exponential backoff
4. **Monitor balances**: Check before placing large orders
5. **Use WebSocket**: For real-time market data
6. **Test first**: Use small amounts to verify integration

## Support

For API questions or issues:
- Email: api-support@biconomy.exchange
- Telegram: @BiconomySupport
- Documentation: https://docs.biconomy.exchange
