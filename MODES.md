# EPWX Bot Modes and Rollout Guide

This document consolidates runtime modes, safe rollout profiles, promotion rules, and rollback triggers for live operations.

## 1) Mode Semantics

- FORCE_BUY_PAUSE=true
  - Hard stop for all buy placements.
  - Sell-side maintenance can still run under existing guards.

- BUY_REACTIVATION_MODE=off
  - Buys disabled by reactivation policy.
  - Sell-side maintenance remains active.

- BUY_REACTIVATION_MODE=auto
  - Buys allowed only when all market-quality and risk gates pass.
  - This is the recommended production mode for controlled activity.

- BUY_REACTIVATION_MODE=on
  - Buys allowed without auto gate blocking.
  - Highest activity and highest loss risk in dislocated conditions.

## 2) Safety Baseline (Always Keep)

- SELF_TRADE_ENABLED=false
- SELF_TRADE_MODE=off
- REBALANCE_COOLDOWN_MS=45000
- REBALANCE_MAX_SPREAD_PERCENT=5
- REBALANCE_MAX_PRICE_DEVIATION_PERCENT=5

## 3) Aggressive Lite v2 (Tighter Profile)

Use this first when market is dislocated and bot is too idle:

```env
FORCE_BUY_PAUSE=false
BUY_REACTIVATION_MODE=auto
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=off

ORDER_FREQUENCY=15000
UPDATE_INTERVAL=15000

TARGET_ORDERS_PER_SIDE=2
TARGET_BUY_DEPTH_USD=10
TARGET_SELL_DEPTH_USD=15

MIN_ORDER_SIZE=5
MAX_ORDER_SIZE=10
MAX_ORDER_AMOUNT_TOKENS=40000000000

IDLE_BALANCE_RESERVE_USD=155
BALANCE_UTILIZATION_PERCENT=0.50

MAX_DEX_CEX_DRIFT_PERCENT=3.5
MAX_EXEC_SPREAD_PERCENT=8.5
MIN_NET_EDGE_BPS=80
MIN_EXEC_DEPTH_BUY_USD=15
MIN_EXEC_DEPTH_SELL_USD=15

ADVERSE_FILL_RATIO_MAX=1.35
RISK_SIZE_MULTIPLIER_DEFENSIVE=0.35
RISK_SIZE_MULTIPLIER_NORMAL=0.55

REBALANCE_COOLDOWN_MS=45000
REBALANCE_MAX_SPREAD_PERCENT=5
REBALANCE_MAX_PRICE_DEVIATION_PERCENT=5
```

## 4) 3-Step Promotion Ladder

### Step 1 (Tighter v2)

- ORDER_FREQUENCY=15000
- UPDATE_INTERVAL=15000
- TARGET_ORDERS_PER_SIDE=2
- TARGET_BUY_DEPTH_USD=10
- TARGET_SELL_DEPTH_USD=15
- IDLE_BALANCE_RESERVE_USD=155
- MAX_DEX_CEX_DRIFT_PERCENT=3.5
- MAX_EXEC_SPREAD_PERCENT=8.5
- MIN_NET_EDGE_BPS=80
- MIN_EXEC_DEPTH_BUY_USD=15
- MIN_EXEC_DEPTH_SELL_USD=15
- ADVERSE_FILL_RATIO_MAX=1.35
- RISK_SIZE_MULTIPLIER_DEFENSIVE=0.35
- RISK_SIZE_MULTIPLIER_NORMAL=0.55

Promote to Step 2 only if all pass for 45-60 minutes:
- Realized PnL trend is flat-to-positive.
- No repeated rebalance warning clusters.
- Inventory is not drifting one-sided for more than 3 consecutive checks.
- Auto-gate pass logs appear occasionally (not permanently blocked).

### Step 2 (Moderate Unlock)

- ORDER_FREQUENCY=13000
- UPDATE_INTERVAL=13000
- TARGET_ORDERS_PER_SIDE=3
- TARGET_BUY_DEPTH_USD=12
- TARGET_SELL_DEPTH_USD=18
- IDLE_BALANCE_RESERVE_USD=150
- MAX_DEX_CEX_DRIFT_PERCENT=4.0
- MAX_EXEC_SPREAD_PERCENT=9.0
- MIN_NET_EDGE_BPS=70
- MIN_EXEC_DEPTH_BUY_USD=12
- MIN_EXEC_DEPTH_SELL_USD=12
- ADVERSE_FILL_RATIO_MAX=1.45
- RISK_SIZE_MULTIPLIER_DEFENSIVE=0.40
- RISK_SIZE_MULTIPLIER_NORMAL=0.65

Promote to Step 3 only if stable for another 60 minutes:
- Realized PnL remains non-negative.
- No fast one-sided inventory build.
- No frequent adverse-fill guard trips.

### Step 3 (Aggressive Lite Target)

- ORDER_FREQUENCY=12000
- UPDATE_INTERVAL=12000
- TARGET_ORDERS_PER_SIDE=3
- TARGET_BUY_DEPTH_USD=15
- TARGET_SELL_DEPTH_USD=20
- IDLE_BALANCE_RESERVE_USD=145
- MAX_DEX_CEX_DRIFT_PERCENT=4
- MAX_EXEC_SPREAD_PERCENT=10
- MIN_NET_EDGE_BPS=60
- MIN_EXEC_DEPTH_BUY_USD=10
- MIN_EXEC_DEPTH_SELL_USD=10
- ADVERSE_FILL_RATIO_MAX=1.5
- RISK_SIZE_MULTIPLIER_DEFENSIVE=0.45
- RISK_SIZE_MULTIPLIER_NORMAL=0.75

## 5) Operator Log Checklist (2-Minute Review)

Run every 10-15 minutes:

```bash
pm2 logs epwx-bot --lines 120 --nostream
```

Optional filter:

```bash
pm2 logs epwx-bot --lines 200 --nostream | egrep "BUY_REACTIVATION_MODE|Auto buy gates|Adverse-fill|Realized|PnL|Position rebalance|Skipping rebalance|Placing depth buy order|FORCE_BUY_PAUSE|drift|spread"
```

Promote candidates (good signs):
- BUY_REACTIVATION_MODE=auto passed
- Placing depth buy order (occasional, not forced every cycle)
- Realized PnL flat-to-positive over repeated checks
- Inventory remains bounded (no persistent one-side growth)

Hold signs (stay on current step):
- blocked buys: spread ...
- blocked buys: DEX/CEX drift ...
- frequent fallback-only sell cycles

Rollback signs (immediate):
- Repeated worsening negative realized PnL across 2-3 checks
- Repeated adverse-fill guard active with growing long inventory
- Repeated rebalance stress logs in short intervals

## 6) Immediate Rollback Procedure

- Set FORCE_BUY_PAUSE=true
- Restart process with updated env

```bash
pm2 restart epwx-bot --update-env
```

## 7) Validation Status Before Rollout

Validated locally before mode planning:
- Full strategy suite passed: 76/76
- Full project suite passed: 150/150
- TypeScript check passed: npx tsc -p tsconfig.json --noEmit

Important:
- Test passes confirm logic and regressions, not live profitability.
- Live market dislocation can still cause losses even when tests are green.

## 8) Balance-Tuned Preset (Current Account Snapshot)

Snapshot provided:
- USDT balance: 343.27617682
- EPWX balance: 4,095,722,220,070.7

Interpretation:
- Buy-side cash is limited relative to your existing EPWX inventory.
- Keep auto gating enabled and bias maintenance toward controlled sell-side depth.
- Avoid BUY_REACTIVATION_MODE=on under this balance mix unless market quality improves significantly.

Recommended profile for this balance (Aggressive Lite v2 - Inventory Aware):

```env
FORCE_BUY_PAUSE=false
BUY_REACTIVATION_MODE=auto
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=off

ORDER_FREQUENCY=15000
UPDATE_INTERVAL=15000

TARGET_ORDERS_PER_SIDE=2
TARGET_BUY_DEPTH_USD=8
TARGET_SELL_DEPTH_USD=20

MIN_ORDER_SIZE=5
MAX_ORDER_SIZE=9
MAX_ORDER_AMOUNT_TOKENS=40000000000

IDLE_BALANCE_RESERVE_USD=165
BALANCE_UTILIZATION_PERCENT=0.45

MAX_DEX_CEX_DRIFT_PERCENT=3.5
MAX_EXEC_SPREAD_PERCENT=8.5
MIN_NET_EDGE_BPS=85
MIN_EXEC_DEPTH_BUY_USD=15
MIN_EXEC_DEPTH_SELL_USD=15

ADVERSE_FILL_RATIO_MAX=1.30
RISK_SIZE_MULTIPLIER_DEFENSIVE=0.30
RISK_SIZE_MULTIPLIER_NORMAL=0.50

REBALANCE_COOLDOWN_MS=45000
REBALANCE_MAX_SPREAD_PERCENT=5
REBALANCE_MAX_PRICE_DEVIATION_PERCENT=5
```

Why these overrides:
- Lower buy depth and higher reserve reduce accidental long accumulation while still allowing occasional buys when gates pass.
- Higher sell depth target supports inventory distribution without forcing marketable behavior.
- Tighter adverse-fill and lower multipliers reduce loss velocity during poor fill-quality windows.

Promotion hint from this preset:
- Only relax to standard Step 1 values after 45-60 minutes of non-negative realized PnL trend and bounded inventory.

Post-cancel reseed override (optional, first 30-60 minutes after manual sell-order cancellation):
- Keep all values from the inventory-aware preset above, and temporarily use:
  - TARGET_SELL_DEPTH_USD=24
  - TARGET_ORDERS_PER_SIDE=3
- After sell-side depth stabilizes and logs show bounded inventory/PnL, return to:
  - TARGET_SELL_DEPTH_USD=20
  - TARGET_ORDERS_PER_SIDE=2

## 9) Mode Files Quick Reference

Use these prebuilt templates directly:

- .env.example.mode-safe-idle
  - Use when you need hard buy-stop safety while keeping minimal sell-side maintenance.
  - Typical use: emergency stabilization or first post-incident restart.

- .env.example.mode-buy-off
  - Use when buy side should remain disabled by policy, but sell-side maintenance should continue.
  - Typical use: inventory-heavy windows where buy risk should stay off.

- .env.example.mode-aggressive-lite-v2
  - Use as the default controlled-activity profile under dislocated conditions.
  - Typical use: first reactivation step from idle.

- .env.example.mode-aggressive-lite-v2-inventory-aware
  - Use for current balance shape with lower buy pressure and stronger reserve protection.
  - Typical use: recommended starting profile for low USDT + large EPWX inventory.

- .env.example.mode-aggressive-lite-step2
  - Use after v2/v2-inventory-aware is stable and promotion criteria are met.
  - Typical use: moderate activity unlock.

- .env.example.mode-aggressive-lite-step3
  - Use after step2 proves stable for another observation window.
  - Typical use: full Aggressive Lite target.

- .env.example.mode-aggressive-on
  - Use only intentionally; this is highest activity and highest loss-risk mode.
  - Typical use: short supervised experiments when market quality is clearly improved.

Suggested progression:
1. .env.example.mode-aggressive-lite-v2-inventory-aware
2. .env.example.mode-aggressive-lite-step2
3. .env.example.mode-aggressive-lite-step3
4. .env.example.mode-aggressive-on (optional, supervised only)

Linux droplet one-liner switch commands (from ~/epowerx_on_base):

- Switch to safe idle:
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-safe-idle .env && pm2 restart epwx-bot --update-env
```

- Switch to buy-off mode:
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-buy-off .env && pm2 restart epwx-bot --update-env
```

- Switch to aggressive-lite v2:
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-aggressive-lite-v2 .env && pm2 restart epwx-bot --update-env
```

- Switch to aggressive-lite v2 inventory-aware (recommended first):
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-aggressive-lite-v2-inventory-aware .env && pm2 restart epwx-bot --update-env
```

- Switch to aggressive-lite step2:
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-aggressive-lite-step2 .env && pm2 restart epwx-bot --update-env
```

- Switch to aggressive-lite step3:
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-aggressive-lite-step3 .env && pm2 restart epwx-bot --update-env
```

- Switch to aggressive-on (supervised only):
```bash
cp .env .env.backup.$(date +%F-%H%M%S) && cp .env.example.mode-aggressive-on .env && pm2 restart epwx-bot --update-env
```

Post-switch quick check:
```bash
pm2 logs epwx-bot --lines 120 --nostream
```

## 10) Dynamic Profile Switching From Production .env

Goal:
- Keep your real production keys in one base file.
- Switch only strategy parameters via small profile override files.
- Avoid retyping properties every time.

Setup once on droplet:

```bash
cd ~/epowerx_on_base
cp .env .env.production.base
chmod +x scripts/switch-profile.sh
```

How it works:
- Base file with secrets: .env.production.base
- Override profiles: profiles/<name>.env
- Switch script merges base + profile and writes .env

List available profiles:

```bash
./scripts/switch-profile.sh --list
```

Apply a profile:

```bash
./scripts/switch-profile.sh aggressive-lite-v2-inventory-aware
pm2 restart epwx-bot --update-env
```

Common profile names:
- safe-idle
- buy-off
- aggressive-lite-v2
- aggressive-lite-v2-inventory-aware
- aggressive-lite-step2
- aggressive-lite-step3
- aggressive-on

Notes:
- The script auto-backs up existing .env as .env.backup.<timestamp> before each switch.
- Keep .env.production.base on the server only; it is git-ignored.
