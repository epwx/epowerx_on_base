# Biconomy Exchange Volume Bot - Quick Start Guide

## 🚀 Quick Setup (5 minutes)

### 1. Get Your Biconomy Exchange API Credentials

1. Log into [Biconomy Exchange](https://biconomy.exchange)
2. Go to **Account** → **API Management**
3. Click **Create New API Key**
4. Enable **Spot Trading** permission
5. Save your **API Key** and **API Secret** (you won't see the secret again!)
6. Verify your account has **MM (Market Maker)** status for zero fees

### 2. Configure the Bot

Copy the environment template:
```bash
cp .env.example .env
```

Edit `.env` file and add your credentials:
```env
BICONOMY_EXCHANGE_API_KEY=your_actual_api_key_here
BICONOMY_EXCHANGE_API_SECRET=your_actual_secret_here
```

### 3. Test Connection

Verify everything works:
```bash
npm run test:connection
```

You should see:
- ✅ Ticker data
- ✅ Order book
- ✅ Account balances
- ✅ Open orders
- ✅ Recent trades

### 4. Start the Bot

Development mode (with hot reload):
```bash
npm run dev
```

Production mode:
```bash
npm run build
npm start
```

## 📊 Expected Results

### First 5 Minutes
- Bot starts placing orders every 5 seconds
- Orders fill quickly due to tight 0.1% spread
- Volume starts accumulating

### First Hour
- ~720 orders placed (2 per 5 seconds)
- $4,000-$5,000 volume generated (with default settings)
- Position stays balanced (±100-200 tokens)

### 24 Hours
- ~35,000 orders placed
- $80,000-$120,000 volume generated
- Zero trading fees (MM account)
- Market-neutral position maintained

## ⚙️ Configuration Presets

### Maximum Volume (Aggressive)
```env
SPREAD_PERCENTAGE=0.05
ORDER_FREQUENCY=3000
MIN_ORDER_SIZE=100
MAX_ORDER_SIZE=1000
SELF_TRADE_ENABLED=true
```
**Result**: $150k+ daily volume, fills very fast

### Balanced (Recommended)
```env
SPREAD_PERCENTAGE=0.1
ORDER_FREQUENCY=5000
MIN_ORDER_SIZE=50
MAX_ORDER_SIZE=500
SELF_TRADE_ENABLED=true
```
**Result**: $100k daily volume, good balance

### Conservative (Safe)
```env
SPREAD_PERCENTAGE=0.2
ORDER_FREQUENCY=10000
MIN_ORDER_SIZE=20
MAX_ORDER_SIZE=200
SELF_TRADE_ENABLED=false
```
**Result**: $50k daily volume, lower risk

## 🎯 Volume Targets

| Target Daily Volume | Min Order | Max Order | Frequency | Spread |
|---------------------|-----------|-----------|-----------|--------|
| $50,000 | 20 | 200 | 10s | 0.2% |
| $100,000 | 50 | 500 | 5s | 0.1% |
| $200,000 | 100 | 1000 | 3s | 0.05% |
| $500,000 | 250 | 2500 | 2s | 0.05% |

## 📈 Monitoring

### Console Output
The bot shows live stats every few seconds:
```
📊 Volume Statistics:
  Total Volume: $12,458.50
  Buy Volume: $6,229.25
  Sell Volume: $6,229.25
  Orders: 328
  Active Orders: 4
  Current Position: 45.25
  Projected 24h: $95,234.00 (95.2% of target)
  Runtime: 3.15 hours
```

### Log Files
All activity is logged to:
- `logs/combined.log` - All activity
- `logs/error.log` - Errors only

## 🛡️ Safety Features

1. **Position Limits**: Automatically rebalances if position grows too large
2. **Daily Loss Limit**: Stops if losses exceed configured amount
3. **Graceful Shutdown**: Ctrl+C cancels all orders and stops safely
4. **Zero Fees**: MM account means 0% trading fees on all trades

## ⚠️ Important Notes

### Before Running
- [ ] Verify MM account status (zero fees)
- [ ] Check sufficient balance in both EPWX and USDT
- [ ] Start with small order sizes for testing
- [ ] Monitor for first 30 minutes

### While Running
- Bot places orders continuously
- Orders should fill within seconds (tight spread)
- Position stays near zero (market neutral)
- Volume accumulates steadily

### Stopping the Bot
Press `Ctrl+C` to stop gracefully:
- All open orders are cancelled
- Final statistics displayed
- Safe to restart anytime

## 🔧 Troubleshooting

### "Authentication failed"
- Check API key and secret in `.env`
- Verify API key has trading permissions
- Check if API key is active

### "Insufficient balance"
- Deposit more EPWX or USDT to your account
- Reduce `MIN_ORDER_SIZE` and `MAX_ORDER_SIZE`

### "Orders not filling"
- Tighten spread: reduce `SPREAD_PERCENTAGE` to 0.05
- Check market liquidity on exchange
- Reduce order sizes

### Position growing too large
- Lower `MAX_POSITION_SIZE`
- Reduce `POSITION_REBALANCE_THRESHOLD`
- Increase `UPDATE_INTERVAL` for more frequent checks

## 💡 Pro Tips

1. **Start Small**: Begin with $50k target and small order sizes
2. **Monitor First Hour**: Watch closely to ensure everything works
3. **Self-Trading**: Enable for maximum volume efficiency
4. **Multiple Bots**: Run multiple instances on different pairs
5. **Adjust Dynamically**: Tweak settings based on results

## 📞 Support

- **Exchange Issues**: Contact Biconomy Exchange support
- **Bot Issues**: Check logs in `logs/` directory
- **Questions**: Open an issue on GitHub

## 🎉 Success Checklist

- [x] Dependencies installed (`npm install`)
- [x] API credentials configured (`.env`)
- [x] Connection test passed (`npm run test:connection`)
- [x] Bot running (`npm run dev`)
- [x] Orders placing successfully
- [x] Volume accumulating
- [x] Position staying balanced

You're all set! The bot is now generating volume on Biconomy Exchange. 🚀
