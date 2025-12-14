# Biconomy Exchange Volume Generation Bot

A high-performance volume generation bot for **Biconomy Exchange** (centralized exchange). Designed for market maker accounts with zero trading fees to efficiently generate trading volume on EPWX/USDT and other pairs.

## Features

- **Zero-Fee Trading**: Optimized for Biconomy Exchange MM accounts with 0% maker/taker fees
- **Volume Generation**: Automated high-frequency order placement for volume creation
- **Smart Order Placement**: Randomized order sizes and tight spreads for natural trading patterns
- **Position Management**: Automatic position rebalancing to maintain market neutrality
- **Risk Controls**: Configurable position limits and daily loss limits
- **Self-Trading Support**: Optional self-trading for maximum volume efficiency
- **Real-time Monitoring**: Live volume statistics and performance tracking
- **Comprehensive Logging**: Detailed Winston logging for monitoring and debugging

## Architecture

```
src/
├── index.ts                                    # Main bot entry point
├── config/
│   └── index.ts                                # Configuration management
├── services/
│   └── biconomy-exchange.service.ts            # Biconomy Exchange API integration
├── strategies/
│   └── volume-generation.strategy.ts           # Volume generation logic
├── scripts/
│   └── test-exchange-connection.ts             # Connection test script
└── utils/
    └── logger.ts                               # Logging setup
```

## Setup

### Prerequisites

- Node.js v18 or higher
- Biconomy Exchange account with MM (Market Maker) privileges
- API Key and Secret from Biconomy Exchange
- Sufficient balance in both EPWX and USDT for trading

### Installation

1. Install dependencies:
```bash
npm install
```

2. Copy the environment template:
```bash
cp .env.example .env
```

3. Configure your `.env` file:

```env
# Biconomy Exchange API Configuration
BICONOMY_EXCHANGE_API_KEY=your_api_key_here
BICONOMY_EXCHANGE_API_SECRET=your_api_secret_here
BICONOMY_EXCHANGE_BASE_URL=https://api.biconomy.exchange

# Trading Configuration
TRADING_PAIR=EPWX/USDT
EPWX_TOKEN_ADDRESS=0xeF5f5751cf3eCA6cC3572768298B7783d33D60Eb

# Volume Generation Strategy
VOLUME_TARGET_DAILY=100000          # Target daily volume in USD
MIN_ORDER_SIZE=50                   # Minimum order size
MAX_ORDER_SIZE=500                  # Maximum order size
SPREAD_PERCENTAGE=0.1               # Tight spread for volume (0.1%)
ORDER_FREQUENCY=5000                # Place orders every 5 seconds
SELF_TRADE_ENABLED=true             # Allow self-trading for volume

# Market Making Parameters
MAX_POSITION_SIZE=5000              # Maximum position to accumulate
POSITION_REBALANCE_THRESHOLD=1000   # Rebalance when position exceeds this
UPDATE_INTERVAL=3000                # Update every 3 seconds

# Risk Management
MAX_SLIPPAGE=0.5                    # Maximum slippage tolerance (%)
DAILY_LOSS_LIMIT=1000               # Stop if daily loss exceeds (USD)
ENABLE_POSITION_LIMITS=true

# Logging
LOG_LEVEL=info
```

### Getting Biconomy Exchange API Keys

1. Log into your Biconomy Exchange account
2. Navigate to Account Settings → API Management
3. Create a new API Key with trading permissions
4. Save your API Key and Secret securely
5. Ensure your account has MM (Market Maker) status for zero fees

## Usage

### Test Connection

First, verify your API credentials work:

```bash
npm run test:connection
```

This will test:
- API authentication
- Ticker data retrieval
- Order book access
- Account balances
- Open orders
- Recent trades

### Build

```bash
npm run build
```

### Run in Development

```bash
npm run dev
```

### Run in Production

```bash
npm start
```

The bot will:
1. Connect to Biconomy Exchange
2. Display current balances
3. Start placing orders at configured frequency
4. Monitor and fill orders automatically
5. Track volume statistics in real-time
6. Rebalance position when needed

## How It Works

### 1. Volume Generation Strategy

The bot implements an aggressive volume generation approach:

1. **High-Frequency Orders**: Places orders every 5 seconds (configurable) on both sides of the market
2. **Tight Spreads**: Uses very tight spreads (0.1% default) to ensure quick fills
3. **Randomized Sizes**: Varies order sizes to appear natural and avoid patterns
4. **Self-Trading**: Optionally allows self-trading to maximize volume efficiency
5. **Position Management**: Monitors and rebalances position to stay market-neutral
6. **Zero Fees**: Leverages MM account status for 0% trading fees on all trades

### 2. Order Lifecycle

```
1. Fetch current market price (bid/ask)
2. Calculate buy price = mid - spread
3. Calculate sell price = mid + spread
4. Place limit orders on both sides
5. Monitor order status
6. Track filled orders and update volume stats
7. Rebalance position if needed
8. Repeat
```

### 3. Key Components

**BiconomyExchangeService**: 
- REST API client for Biconomy Exchange
- HMAC-SHA256 request signing
- Order placement, cancellation, and monitoring
- Balance and market data retrieval

**VolumeGenerationStrategy**:
- Volume target tracking
- High-frequency order placement
- Position monitoring and rebalancing
- Performance statistics and reporting

## Configuration

### Volume Strategy Parameters

- `VOLUME_TARGET_DAILY`: Target daily volume in USD (e.g., 100000 = $100k)
- `MIN_ORDER_SIZE`: Minimum size for each order
- `MAX_ORDER_SIZE`: Maximum size for each order
- `SPREAD_PERCENTAGE`: Spread between buy/sell orders (0.1% = very tight)
- `ORDER_FREQUENCY`: Time between order placements in milliseconds (5000 = 5 sec)
- `SELF_TRADE_ENABLED`: Allow orders to fill against your own orders

### Position Management

- `MAX_POSITION_SIZE`: Maximum position to accumulate before rebalancing
- `POSITION_REBALANCE_THRESHOLD`: Position size that triggers rebalancing
- `UPDATE_INTERVAL`: Status check frequency in milliseconds (3000 = 3 sec)

### Risk Management

- `MAX_SLIPPAGE`: Maximum acceptable slippage percentage
- `DAILY_LOSS_LIMIT`: Stop trading if daily loss exceeds this amount
- `ENABLE_POSITION_LIMITS`: Enable/disable position limit enforcement

## Volume Generation Strategies

### Conservative Volume (Low Risk)

```env
SPREAD_PERCENTAGE=0.2
ORDER_FREQUENCY=10000
MIN_ORDER_SIZE=20
MAX_ORDER_SIZE=200
MAX_POSITION_SIZE=2000
```

- Wider spreads reduce fill rate but lower risk
- Slower order frequency
- Smaller order sizes

### Aggressive Volume (High Volume)

```env
SPREAD_PERCENTAGE=0.05
ORDER_FREQUENCY=3000
MIN_ORDER_SIZE=100
MAX_ORDER_SIZE=1000
MAX_POSITION_SIZE=10000
```

- Tighter spreads for faster fills
- Higher order frequency
- Larger order sizes for maximum volume

### Balanced Approach (Recommended)

```env
SPREAD_PERCENTAGE=0.1
ORDER_FREQUENCY=5000
MIN_ORDER_SIZE=50
MAX_ORDER_SIZE=500
MAX_POSITION_SIZE=5000
```

- Moderate spreads for good fill rate
- Balanced frequency and size
- Manageable position risk

## Monitoring

### Console Output

The bot provides real-time statistics:

```
📊 Volume Statistics:
  Total Volume: $45,782.50
  Buy Volume: $22,891.25
  Sell Volume: $22,891.25
  Orders: 1,247
  Active Orders: 8
  Current Position: 125.50
  Projected 24h: $98,567.20 (98.6% of target)
  Runtime: 11.23 hours
```

### Log Files

- `logs/combined.log`: All activity logs
- `logs/error.log`: Error logs only
- `logs/exceptions.log`: Uncaught exceptions
- `logs/rejections.log`: Unhandled promise rejections

### Key Metrics

- **Total Volume**: Cumulative USD volume generated
- **Buy/Sell Volume**: Breakdown of directional volume
- **Order Count**: Total orders placed
- **Active Orders**: Currently open orders
- **Position**: Current net position (positive = long, negative = short)
- **Projected 24h**: Estimated daily volume based on current rate

## Security Considerations

1. **API Credentials**: Never commit your `.env` file or expose API keys
2. **API Permissions**: Use API keys with only necessary trading permissions
3. **Position Limits**: Set appropriate `MAX_POSITION_SIZE` to manage risk
4. **Daily Limits**: Configure `DAILY_LOSS_LIMIT` to cap potential losses
5. **IP Whitelist**: Enable IP whitelisting on Biconomy Exchange for API keys
6. **Monitoring**: Regularly monitor bot activity and account balances
7. **Start Small**: Test with small amounts before scaling up

## Troubleshooting

### Authentication Errors
- Verify API key and secret are correct
- Check API key has trading permissions enabled
- Ensure your account has MM status for zero fees
- Verify signature generation is working (HMAC-SHA256)

### Orders Not Filling
- Spreads may be too wide - tighten `SPREAD_PERCENTAGE`
- Order sizes may be too large - reduce `MAX_ORDER_SIZE`
- Market may be illiquid - check order book depth
- Self-trading may be disabled on exchange

### Position Growing Too Large
- Reduce `MAX_POSITION_SIZE` limit
- Lower `POSITION_REBALANCE_THRESHOLD`
- Increase `UPDATE_INTERVAL` for more frequent checks
- Enable `ENABLE_POSITION_LIMITS` if disabled

### Low Volume Generation
- Increase `ORDER_FREQUENCY` (place orders more often)
- Tighten `SPREAD_PERCENTAGE` for faster fills
- Increase `MAX_ORDER_SIZE` for larger orders
- Enable `SELF_TRADE_ENABLED` for maximum efficiency

## Performance Optimization

### Maximizing Volume

1. **Use Tight Spreads**: 0.05-0.1% spreads fill fastest
2. **High Frequency**: 3-5 second intervals for maximum orders
3. **Enable Self-Trading**: Allows your orders to match each other
4. **Randomize Sizes**: Makes trading appear more natural
5. **Multiple Pairs**: Run multiple bots on different pairs

### Minimizing Risk

1. **Position Limits**: Keep `MAX_POSITION_SIZE` reasonable
2. **Stop Loss**: Set `DAILY_LOSS_LIMIT` appropriately
3. **Start Small**: Test with small sizes first
4. **Monitor Closely**: Watch logs and statistics
5. **Rebalance Often**: Lower `POSITION_REBALANCE_THRESHOLD`

## Development

### Project Structure

- **Services**: Biconomy Exchange API integration
- **Strategies**: Volume generation and market making logic
- **Utils**: Logging and helper functions
- **Config**: Environment and configuration management
- **Scripts**: Testing and utility scripts

### Adding Features

The codebase is modular and easy to extend:

- Add new strategies in `src/strategies/`
- Add exchange features in `src/services/`
- Add utilities in `src/utils/`
- Configuration in `src/config/`

## License

MIT

## Example Output

```
╔══════════════════════════════════════════════════════╗
║   BICONOMY EXCHANGE VOLUME GENERATION BOT           ║
║   Zero-Fee Market Maker Account                      ║
╚══════════════════════════════════════════════════════╝

🚀 Starting Biconomy Exchange Volume Generation Bot...
Target: $100,000 daily volume
Pair: EPWX/USDT
Spread: 0.1%
Order Frequency: 5000ms

💰 Account Balances:
  EPWX: 10000.00000000 (Free: 9875.50000000, Locked: 124.50000000)
  USDT: 50000.00000000 (Free: 48925.75000000, Locked: 1074.25000000)

✅ Volume generation bot started successfully

📊 Buy order placed: 127.45 @ $0.392500
📊 Sell order placed: 132.18 @ $0.393500
✅ Order filled: BUY 127.45 @ $0.392500 | Volume: $50.02
✅ Order filled: SELL 132.18 @ $0.393500 | Volume: $52.00

📊 Volume Statistics:
  Total Volume: $5,428.50
  Buy Volume: $2,714.25
  Sell Volume: $2,714.25
  Orders: 142
  Active Orders: 6
  Current Position: 12.75
  Projected 24h: $98,234.40 (98.2% of target)
  Runtime: 1.33 hours
```

## Support

For issues related to:
- **Biconomy Exchange**: Contact Biconomy Exchange support
- **API Issues**: Check Biconomy Exchange API documentation
- **This Bot**: Open an issue in the repository

## Disclaimer

This bot is for volume generation on **Biconomy Exchange** (centralized exchange). It is designed for accounts with market maker status and zero trading fees. 

**Use at your own risk.** 
- Always start with small amounts
- Monitor the bot closely
- Understand the risks of automated trading
- Volume generation may be subject to exchange rules
- Ensure compliance with exchange terms of service

Market making and volume generation involve financial risk and may result in losses.