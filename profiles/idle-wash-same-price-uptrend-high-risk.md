# Idle Wash Same Price Uptrend High Risk Profile

This document defines the production source of truth for:

- `profiles/idle-wash-same-price-uptrend-high-risk.env`

It explains each setting, the intended runtime behavior, and operational risks.

## Purpose

This profile is intentionally aggressive for stressed market conditions.

- Goal: keep same-price protected wash logic active while market spread and drift are unusually high.
- Trade-off: higher execution risk and higher chance of safety clamps compared with conservative profiles.
- Safety retained: external-liquidity protection remains enabled.

## Effective Configuration

### Core mode and matching

- `BUY_REACTIVATION_MODE=on`
	- If buys are gated (for example low spendable USDT), wash placements are skipped to avoid one-sided exposure.
- `SELF_TRADE_ENABLED=true`
	- Enables self-trade orchestration behavior.
- `SELF_TRADE_MODE=on`
	- Allows disappeared-order reconciliation to settle paired wash legs as synthetic matched fills.

### Market guardrails and execution envelope

- `MAX_DEX_CEX_DRIFT_PERCENT=45`
	- Allows operation while DEX and CEX reference prices differ up to 45%.
- `MAX_EXEC_SPREAD_PERCENT=600`
	- Keeps the strategy active in very wide books; above this threshold placements are blocked.
- `MIN_EXEC_DEPTH_BUY_USD=5`
	- Minimum executable buy-side depth requirement.
- `MIN_EXEC_DEPTH_SELL_USD=5`
	- Minimum executable sell-side depth requirement.
- `MIN_NET_EDGE_BPS=0`
	- No additional net-edge buffer is required for placement.

### Inventory and placement targets

- `IDLE_BALANCE_RESERVE_USD=278.0`
	- USDT reserve that is withheld from spendable buy budget.
- `TARGET_ORDERS_PER_SIDE=1`
	- One active buy target and one active sell target.
- `TARGET_BUY_DEPTH_USD=0`
	- No regular buy book-depth expansion target.
- `TARGET_SELL_DEPTH_USD=0`
	- No regular sell book-depth expansion target.
- `ORDER_FREQUENCY=20000`
	- Placement loop interval is 20 seconds.

### Idle wash timing and sizing

- `IDLE_WASH_ENABLE_AFTER_MS=120000`
	- Idle wash eligible after 2 minutes without disqualifying activity.
- `IDLE_WASH_COOLDOWN_AFTER_REAL_FILL_MS=600000`
	- 10-minute cooldown after real fills before idle wash resumes.
- `IDLE_WASH_MAX_PAIRS_PER_CYCLE=1`
	- At most one wash pair per cycle.
- `WASH_ORDER_SIZE_CAP_USD=5.01`
	- Per-order wash notional cap.

### High-risk drift and spread behavior

- `IDLE_WASH_REQUIRE_LOW_DRIFT=false`
	- Wash logic can continue without a strict low-drift requirement.
- `IDLE_WASH_MAX_DRIFT_PERCENT=45`
	- Drift cap for idle wash path.
- `IDLE_WASH_MAX_EXEC_SPREAD_PERCENT=600`
	- Wide spread tolerance for idle wash execution path.
- `PAUSE_WASH_ON_HIGH_DRIFT=false`
	- Wash flow is not automatically paused solely due to high drift.

### Uptrend mechanics

- `IDLE_WASH_SAME_PRICE_UPWARD_STEP_BPS_PER_MINUTE=250`
	- Uptrend step is 250 bps per minute while idle.
- `IDLE_WASH_SAME_PRICE_UPWARD_MAX_BPS=1200`
	- Uptrend offset caps at 1200 bps.

Derived interpretation:

- Ramp rate: 2.5% price offset increase per idle minute.
- Max offset: 12.0% above the selected reference price.

### External-liquidity protection

- `IDLE_WASH_PROTECT_EXTERNAL_BUYS=true`
	- Prevents buy leg placement into unsafe external ask liquidity.
- `IDLE_WASH_PROTECT_MIN_SPREAD_TICKS=30`
	- Requires spread headroom in ticks before protected wash buy proceeds.

## Expected Runtime Behavior

In dislocated books, the strategy commonly shows:

1. Wide-spread warning and fallback to ticker mid for placement scaffolding.
2. DEX reference retained for wash pricing logic.
3. Uptrend increases planned wash price while idle.
4. Protection clamps planned price downward when external ask risk exists.
5. In self-trade mode, order disappearance is reconciled as synthetic matched wash fills.

When buy budget is gated by reserve:

1. Buy placements are paused.
2. New sell placements are frozen to avoid one-sided exposure.
3. Wash pairs are skipped until buy-side reactivates.

## Operational Notes

- This profile is production-critical and should be changed cautiously.
- If volume stalls with messages about spendable USDT below minimum notional, review:
	- available free USDT,
	- reserve value (`IDLE_BALANCE_RESERVE_USD`),
	- buy reactivation gating state.
- If upward trend appears active but executed price seems flat, protection clamping is usually the cause under hostile external liquidity.

## Change Control

For any updates to `profiles/idle-wash-same-price-uptrend-high-risk.env`, update this markdown in the same commit so it remains the source-of-truth companion document.
