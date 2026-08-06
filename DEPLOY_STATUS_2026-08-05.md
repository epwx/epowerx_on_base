# EPWX Bot Deployment Status - 2026-08-05

## Scope
This document summarizes all major changes and production actions completed in this session for legit market-making safety, profile auto-switching, and sell-only recovery operations.

## Repository and Runtime State
- Repo: epowerx_on_base
- Branch: main
- Runtime process: PM2 app `epwx-bot`
- Pair: EPWX/USDT
- Current operating profile in production: `legit-market-making-sell-only-recovery`

## Completed Code Changes

### 1) Profile detection and base env merge
- Commit: `5325eff`
- File: `scripts/switch-profile.sh`
- Added robust active-profile detection by matching profile keys/values, not full-file `cmp`.
- Added support to merge `.env.production.base` + selected profile override file into `.env`.
- Result: auto mode no longer fails with `Current profile: unknown` in base+override deployments.

### 2) Auto-switch tuning for safer/faster recovery
- Commit: `bcb59fc`
- Files:
  - `scripts/switch-profile.sh`
  - `profiles/legit-market-making-real-user.env`
- Updated auto-switch defaults:
  - enter dislocated: `18`
  - exit dislocated: `6`
  - confirm cycles: `4`
- Aligned real-user executable spread breaker:
  - `MAX_EXECUTABLE_SPREAD_CIRCUIT_BREAKER_PERCENT=6`

### 3) Sell-only recovery profile and optional auto path
- Commit: `6e2f751`
- Files:
  - `profiles/legit-market-making-sell-only-recovery.env` (new)
  - `scripts/switch-profile.sh`
- Added new profile for stressed conditions with buys hard-paused and self-trade off.
- Added optional auto-switch path flag:
  - `AUTO_SWITCH_USE_SELL_ONLY_RECOVERY=true`
- Auto mode can now keep stressed market behavior in sell-only recovery and switch to real-user once exit threshold passes.

### 4) Sell-only fill-probability tuning
- Commit: `b17e35b`
- File: `profiles/legit-market-making-sell-only-recovery.env`
- Reduced and tightened sell quoting:
  - lower sell depth target
  - faster cycle
  - limited churn refresh
  - tighter passive sell offsets
  - lower per-order max token cap
- Goal: improve real-user hit probability with smaller, tighter asks.

### 5) Same-price sell-stack avoidance
- Commit: `f9398d5`
- File: `src/strategies/volume-generation.strategy.ts`
- Added sell-price offset logic that checks open sell levels and nudges new clamped sells by tick(s) when needed.
- Added tick-size tracking from pair info.
- Result observed: sell quotes now appear across nearby ticks (not all identical).

## Production Actions Completed
- Pulled and built latest commits on server multiple times.
- Activated `legit-market-making-sell-only-recovery` manually via script.
- Verified PM2 restart and runtime SHA markers in logs.
- Enabled auto-switch cron with lock protection.

## Active Cron Configuration
Current cron entry in production:

`*/2 * * * * cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base && AUTO_SWITCH_USE_SELL_ONLY_RECOVERY=true AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT=3 /usr/bin/flock -n /tmp/epwx-switch.lock ./scripts/switch-profile.sh --auto >> /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/profile-switch-cron.log 2>&1`

Notes:
- Interval: every 2 minutes
- Exit normalization threshold: `3%` (strict)
- Confirm cycles: `4` (from script default)

## Current Observed Market/Behavior
- Historical spread regime has been extreme (examples: `184.897%`, later around `112.929%`).
- Under dislocated profile, strategy frequently paused due to 15% breaker.
- Under sell-only recovery profile:
  - buys are policy-paused (`FORCE_BUY_PAUSE=true`, `BUY_REACTIVATION_MODE=off`)
  - sell orders are being placed successfully
  - open order table shows 3 sell orders with near-tick-separated prices
- No evidence of self-trade/wash activation in this mode.

## Operational Clarifications
- `--dry-run` on `switch-profile.sh` never places exchange orders.
- Manual profile switch command is live and restarts PM2.
- Auto-switch decisions depend on recent spread samples and hysteresis thresholds.
- A lower exit threshold (for example `3%`) is safer but delays return to real-user mode.

## Known Edge Cases Seen
- Mixed old/new threshold lines in cron log tails were due to historical log content.
- Occasional transient `Current profile: unknown` occurred when `.env` content lagged profile updates; resolved by re-applying profile switch after pulls.

## Recommended Monitoring Commands
- `tail -f /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/profile-switch-cron.log`
- `pm2 logs epwx-bot --lines 200`
- `crontab -l | grep "scripts/switch-profile.sh --auto"`

## Immediate Next Options
- Keep current strict mode until 4 consecutive spreads are `<= 3%`, then auto-switch to real-user.
- If fill rate remains low, further reduce sell clip size and tighten passive sell offsets incrementally.
- If desired, add a second conservative sell-only profile for faster rollback between aggressive and conservative sell-only behavior.

## 2026-08-05 Profit-Oriented Profile Delta (Post-Stop Update)
- Updated profile: `profiles/legit-market-making-real-user.env`
  - `MAX_DEX_CEX_DRIFT_PERCENT=25`
  - `MAX_EXECUTABLE_SPREAD_CIRCUIT_BREAKER_PERCENT=12`
  - `MIN_NET_EDGE_BPS=6`
  - `IDLE_BALANCE_RESERVE_USD=200`
  - `TARGET_BUY_DEPTH_USD=24`
  - `TARGET_SELL_DEPTH_USD=24`
  - `ORDER_FREQUENCY=7000`
  - `QUOTE_CHURN_REFRESH_PER_SIDE=1`
  - `MAX_ORDER_AMOUNT_TOKENS=25000000000`
  - `SELL_NEAR_BID_ENABLED=true`
  - `SELL_NEAR_BID_TICKS=1`
  - `SELL_NEAR_BID_MIN_MARKUP_BPS=2`

- Updated profile: `profiles/legit-market-making-dislocated.env`
  - `IDLE_BALANCE_RESERVE_USD=200`
  - `TARGET_BUY_DEPTH_USD=16`
  - `TARGET_SELL_DEPTH_USD=16`
  - `ORDER_FREQUENCY=12000`
  - `QUOTE_CHURN_REFRESH_PER_SIDE=1`
  - `MAX_ORDER_AMOUNT_TOKENS=25000000000`
  - `SELL_NEAR_BID_ENABLED=true`
  - `SELL_NEAR_BID_TICKS=1`
  - `SELL_NEAR_BID_MIN_MARKUP_BPS=2`

Execution note:
- Local workspace could not run live operational commands because `.env` and exchange credentials are not present here.
- `scripts/switch-profile.sh` requires `.env` to exist.
