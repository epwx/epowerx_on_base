# Hybrid Profile Draft: Real User Profit + Idle Wash Support

## Objective
Create a single production profile that:
- prioritizes real-user profitable fills when market quality is acceptable
- keeps controlled volume continuity with idle wash when real flow is absent
- reduces directional inventory risk during low-quality windows

This is a design draft only. No strategy logic changes are required for initial rollout.

## Why current idle-wash-same-price is not enough
Current mode in [epowerx_on_base/.env.example.mode-idle-wash-same-price](.env.example.mode-idle-wash-same-price) is volume-first:
- SELF_TRADE_MODE=on forces continuous wash behavior
- TARGET_BUY_DEPTH_USD=0 and TARGET_SELL_DEPTH_USD=0 disable real-user quote depth objective
- BUY_REACTIVATION_MODE=on bypasses auto quality gating
- IDLE_WASH_COOLDOWN_AFTER_REAL_FILL_MS=0 gives no pause after real interaction

Result: strong synthetic throughput, weak real-user profit focus.

## Proposed behavior model
Use hybrid priority:
1. Real-user quote mode is the default.
2. Idle wash activates only after a no-real-fill idle window.
3. Any real fill pauses wash for a cooldown window.
4. Auto market-quality gates remain active for buy-side risk control.
5. Non-zero quote depth targets keep real-user interaction available.

## Draft profile values
Create a new profile file, for example:
- profiles/hybrid-profit-idle-wash.env
- .env.example.mode-hybrid-profit-idle-wash

Draft env values:

```env
# Core mode
FORCE_BUY_PAUSE=false
BUY_REACTIVATION_MODE=auto
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=auto

# Loop cadence
ORDER_FREQUENCY=20000
UPDATE_INTERVAL=20000

# Real-user quoting objective (non-zero depth)
TARGET_ORDERS_PER_SIDE=1
TARGET_BUY_DEPTH_USD=8
TARGET_SELL_DEPTH_USD=12

# Balance and sizing
BALANCE_UTILIZATION_PERCENT=0.45
IDLE_BALANCE_RESERVE_USD=317.0
MIN_ORDER_SIZE=5
MAX_ORDER_SIZE=8
MAX_ORDER_AMOUNT_TOKENS=40000000000
WASH_ORDER_SIZE_CAP_USD=5.05

# Market-quality and execution gates
MAX_DEX_CEX_DRIFT_PERCENT=4
MAX_EXEC_SPREAD_PERCENT=8
MIN_NET_EDGE_BPS=80
MIN_EXEC_DEPTH_BUY_USD=20
MIN_EXEC_DEPTH_SELL_USD=20

# Idle wash controls (gated)
WASH_BASE_PAIRS_PER_CYCLE=1
WASH_MAX_PAIRS_PER_CYCLE=1
IDLE_WASH_ENABLE_AFTER_MS=90000
IDLE_WASH_COOLDOWN_AFTER_REAL_FILL_MS=180000
IDLE_WASH_MAX_PAIRS_PER_CYCLE=1
IDLE_WASH_REQUIRE_LOW_DRIFT=true
IDLE_WASH_MAX_DRIFT_PERCENT=3.5
IDLE_WASH_MAX_EXEC_SPREAD_PERCENT=8
PAUSE_WASH_ON_HIGH_DRIFT=true

# Risk and inventory
ADVERSE_FILL_RATIO_MAX=1.4
RISK_SIZE_MULTIPLIER_DEFENSIVE=0.35
RISK_SIZE_MULTIPLIER_NORMAL=0.55
MAX_POSITION_SIZE=5000
POSITION_REBALANCE_THRESHOLD=200
REBALANCE_COOLDOWN_MS=45000
REBALANCE_MAX_SPREAD_PERCENT=5
REBALANCE_MAX_PRICE_DEVIATION_PERCENT=5

# Logging
LOG_LEVEL=info
```

## Expected outcomes
If market quality is acceptable:
- more real-user-facing quote persistence
- gradual increase in real fills over time
- lower dependence on synthetic-only turnover

If market quality degrades:
- auto gating should suppress risky buy behavior
- wash should only resume under drift/spread constraints
- inventory should remain bounded with existing rebalance protections

## Rollout plan
Phase 1, 30-60 minutes:
- deploy hybrid profile with conservative defaults above
- monitor real-fills count, realized pnl trend, position drift

Phase 2, 60-120 minutes if stable:
- optionally reduce IDLE_WASH_ENABLE_AFTER_MS from 90000 to 60000
- optionally increase TARGET_BUY_DEPTH_USD and TARGET_SELL_DEPTH_USD by small steps

Phase 3, after repeated stable windows:
- tune MIN_NET_EDGE_BPS down modestly only if real-fill capture remains too low

## Rollback triggers
Immediately rollback to safer mode if:
- repeated negative realized pnl trend across 2-3 check windows
- persistent one-sided inventory growth
- repeated rebalance stress logs in short intervals

## Metrics to track per check window
- Real Fills
- Realized PnL
- Total Volume vs Wash Trades ratio
- Current Position and inventory cost basis
- Spread and drift gate frequency

## Notes
- This draft assumes existing code paths for auto wash cooldown and drift/spread checks remain active.
- If real-fill attribution visibility is still insufficient, next step would be adding explicit real-vs-wash attribution logs in strategy stats output.
