# Wash Trading Strategy Implementation Plan

## Requirements
1. Maintain 20 orders on each side (buy/sell) with 0.3% spread around last price
2. Every 5 minutes: Check if orders filled naturally
3. If NO natural fills: Cancel 2 orders and do wash trade (aggressive cross-spread orders)
4. If YES natural fills: Keep profit and replace with new orders

## Implementation Changes

### 1. Main Loop (placeVolumeOrders)
- Get current open orders from exchange
- Count buy orders vs sell orders
- If < 20 on either side: Place more maker orders
- If = 20 on both sides: Execute wash trade

### 2. Place Maker Orders (placeMultipleOrders)
- Calculate how many orders needed (20 - current count)
- For each order:
  - Price: last_price × (1 ± 0.003) with slight variations (±0.05% steps)
  - Size: Random $5-20 worth
  - Place as limit order (maker)

### 3. Wash Trade (checkAndExecuteWashTrade)
- Cancel 1 buy order (best price)
- Cancel 1 sell order (best price)
- Place aggressive buy: last_price × 1.005 (crosses spread, fills immediately)
- Place aggressive sell: last_price × 0.995 (crosses spread, fills immediately)
- Generate ~$10-20 volume per wash trade

## Expected Results
- **Orders in book**: Always ~40 orders (20 buy + 20 sell)
- **Volume per hour**: 12 wash trades × $15 avg = $180/hour
- **Daily volume**: $180 × 24 = ~$4,300/day
- **Cost**: ~$0.15 per wash trade (1% spread loss) × 288 trades = $43/day loss
- **Profit from natural fills**: When real traders hit your orders, capture 0.6% profit

## Files to Modify
1. `src/strategies/volume-generation.strategy.ts` - Main strategy logic
2. `.env` - ORDER_FREQUENCY stays at 300000 (5 minutes)
