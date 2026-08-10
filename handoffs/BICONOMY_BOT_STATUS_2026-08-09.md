# EPWX Biconomy Bot Status - 2026-08-09

## Purpose

This is the handoff document for continuing work on the production Biconomy `epwx-bot` in a new context window. It records the live process, account state, active profile, automatic switching, safety controls, deployment drift, and recommended next actions as of 2026-08-09 10:56 UTC.

For earlier deployment history and profile rationale, also read `DEPLOY_STATUS_2026-08-05.md`.

## Executive Status

- Production host: `deployer@104.131.164.145`
- Production root: `/mnt/volume1_nyc3_1778885684099/epowerx_on_base`
- PM2 process: `epwx-bot`
- PM2 process ID: `3`
- PID at last check: `872699`
- Process created: `2026-08-09T04:19:59.129Z`
- Status at capture: `online`
- Uptime at capture: approximately 6 hours
- Historical restart count: `165`
- Unstable restarts: `0`
- Exchange: Biconomy
- Pair: `EPWX/USDT`
- Active profile: `legit-market-making-sell-only-recovery`
- Profile mode: live trading, not shadow mode

The running process was not restarted or reconfigured during the Azbit shadow deployment on 2026-08-09.

## Current Safety Controls

Verified in production `.env`:

```env
FORCE_BUY_PAUSE=true
BUY_REACTIVATION_MODE=off
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=off
CANCEL_ORDERS_ON_START=true
CANCEL_ORDERS_ON_STOP=false
```

Operational meaning:

- No new BUY orders should be placed.
- Self-trading and wash trading are disabled.
- The strategy maintains SELL-side liquidity only.
- Starting or restarting the bot cancels existing Biconomy orders before reseeding.
- A normal stop does not cancel existing orders.

Do not enable BUY placement or self-trading without reviewing inventory, balances, fill asymmetry, spread, and the active profile first.

## Secret Handling

- Biconomy API credentials and the Base RPC URL live only in the server-local `.env`.
- `.env` is mode `0600`.
- Do not print, copy, commit, or document secret values.
- Deployments must preserve `.env`; never replace it with a tracked profile file.
- Safe diagnostics may print masked API fields only.

## Active Profile

State file at capture:

```text
profile=legit-market-making-real-user
reason=auto-switch: spread normalized below exit threshold
```

The operator first switched to `legit-market-making-dislocated`, which seeded
both sides and tightened the spread below the automatic `6%` exit threshold.
Cron then selected `legit-market-making-real-user` as designed. Important
active values are:

```env
BUY_REACTIVATION_MODE=auto
FORCE_BUY_PAUSE=false
DEX_PRICE_DISCOUNT_PERCENT=26
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=off
MAX_DEX_CEX_DRIFT_PERCENT=25
TARGET_ORDERS_PER_SIDE=3
TARGET_BUY_DEPTH_USD=24
TARGET_SELL_DEPTH_USD=24
ORDER_FREQUENCY=7000
QUOTE_CHURN_REFRESH_PER_SIDE=1
```

The profile uses the Base Chainlink ETH/USD feed and has a static fallback configured. The actual RPC URL remains secret in `.env`.

## Automatic Profile Switching

Production cron is live and can apply profile changes:

```cron
*/2 * * * * cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base && AUTO_SWITCH_USE_SELL_ONLY_RECOVERY=false AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT=6 AUTO_SWITCH_CONFIRM_CYCLES=3 /usr/bin/flock -n /tmp/epwx-switch.lock ./scripts/switch-profile.sh --auto >> /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/profile-switch-cron.log 2>&1
```

Current behavior:

- Runs every 2 minutes.
- Uses a lock to prevent overlapping switches.
- Requires 3 confirming samples.
- Enters dislocated handling at spread `>= 18%`.
- Exits dislocated handling at spread `<= 6%`.
- Persistent stress now selects the two-sided `legit-market-making-dislocated`
  profile instead of sell-only recovery.
- A spread at or below `6%` selects `legit-market-making-real-user`.
- Self-trading remains disabled in both profiles.

Unlike the Azbit cron, this Biconomy cron is not dry-run. A confirmed profile change updates `.env` and restarts `epwx-bot`. Because `CANCEL_ORDERS_ON_START=true`, that restart cancels and reseeds open orders.

## Current Market Snapshot

Read-only connection diagnostic at approximately 2026-08-10 03:21 UTC:

- Best bid: `1.004e-10`
- Best ask: `1.007e-10`
- Executable spread: approximately `0.299%`
- Discounted DEX reference at 26%: approximately `6.2313e-11`
- DEX/CEX drift: approximately `38.03%`
- Active normal-profile drift limit: `25%`

The normal profile retains existing quotes but pauses additional BUY
replenishment while drift remains above `25%`.

## Account and Orders

Read-only connection diagnostic at approximately 2026-08-10 03:21 UTC:

- EPWX total: `1582512618113.5`
- EPWX free: `1532586998927.5`
- EPWX locked: `49925619186`
- USDT total: `673.88156915`
- USDT free: `668.86156915`
- USDT locked: `5.02`
- Open orders: `4` (`2 BUY`, `2 SELL`)

The resting real orders were:

```text
BUY  25000000000 EPWX @ 1.004e-10
BUY  25000000000 EPWX @ 1.004e-10
SELL 24975189997 EPWX @ 1.007e-10
SELL 24950429189 EPWX @ 1.010e-10
```

The initial two-sided seed also produced one reconciled external BUY fill:

```text
BUY 21907413385 EPWX
USDT balance delta: -2.2105
Estimated balance delta at mark: -$0.0077
```

The initial requested BUY was repriced to `1.037785e-10`, above the then-best
ask `1.009e-10`, and filled immediately. Treat post-clamp non-crossing
validation as a required follow-up before another reseed.

## Current Runtime Behavior

Recent cycles showed stable `2 BUY / 2 SELL` real orders and no further fills.
The process is online, self-trading remains disabled, and the error log has not
changed since 2026-08-07. BUY replenishment is currently blocked by the normal
profile's `25%` drift gate; if spread again persists above `18%`, cron will use
the two-sided dislocated profile rather than sell-only recovery.

## Persistent Accounting

Active state file:

```text
logs/runtime-pnl-state.biconomy.json
```

State at approximately 2026-08-09 10:56 UTC:

```text
orderCount=6
totalVolume=0
realFills=0
washTrades=0
realizedPnl=0
unrealizedPnl=0
inventoryQuantity=0
inventoryMarkPrice=9.24e-11
lifetimeBaselineEpwx=1560605204728.5
lifetimeBaselineUsdt=676.0920271613128
latestEpwxTotal=1560605204728.5
latestUsdtTotal=676.0920271613128
```

The state file was actively updating, confirming that the running process remained healthy.

## Repository and Deployment State

Local repository:

- Branch: `main`
- Local and `origin/main`: `314a9a8 Harden and document Azbit shadow runtime`
- Worktree was clean before this handoff file was created.

Production server:

- Git checkout: `aae6168`
- Runtime log marker: `aae6168`
- Running Biconomy process loaded its strategy when it started at 04:19 UTC.

Shared on-disk strategy artifact:

```text
dist/strategies/volume-generation.strategy.js
SHA-256: c3e6e7832425a57b4930dcb1c9ac8f166bd21d0a6152ba87a4e3ce359234f1c0
```

### Shared Artifact Caveat

Azbit shadow remediation selectively updated the shared on-disk strategy artifact after the Biconomy process started. The running Biconomy process still has its earlier strategy code loaded in memory.

On the next Biconomy restart, it will load these additional exchange-neutral safety changes from disk:

1. Construct the exchange through `createExchangeService()`.
2. Resolve runtime state through `config.runtime.stateFile`.
3. Reject non-finite or non-positive DEX prices before quote logic.

For `EXCHANGE_NAME=biconomy`, the factory still creates `BiconomyExchangeService`, and the configured/default state path resolves to `logs/runtime-pnl-state.biconomy.json`. Even so, treat the next Biconomy restart as a deployment event and validate it immediately.

Do not restore an older shared strategy artifact merely to reproduce the current in-memory Biconomy code. Doing so can break Azbit shadow routing on its next restart.

## Existing Backups

Relevant shared-artifact backups on the server include:

- `/tmp/volume-generation.strategy.pre-factory-fix.js`
- `/tmp/azbit-dex-config-backup-20260809T1042/volume-generation.strategy.js`

These are rollback evidence, not automatic restore targets. Any restore must account for both `epwx-bot` and `epwx-azbit-bot` because they share the same on-disk `dist` tree.

## Validation Status

Passed at capture:

- PM2 process online
- No unstable PM2 restarts
- Biconomy ticker read
- Biconomy order-book read
- Biconomy balance read
- Biconomy open-order read
- Three open SELL orders reconciled with locked EPWX
- No locked USDT
- DEX price read
- Profile auto-switch continued retaining sell-only recovery
- Persistent Biconomy state file continued updating

Known repository test issue:

- The complete strategy Jest file is not currently deterministic because tests may load `logs/runtime-pnl-state.biconomy.json`.
- A PnL test expected `$5` unrealized PnL but received `$60` from persisted local state.
- Focused tests and TypeScript checks pass, but test runtime-state isolation should be fixed before treating the full suite as a release gate.

## Safe Monitoring Commands

These commands do not print credentials:

```bash
ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'pm2 describe epwx-bot'

ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'tail -n 100 /home/deployer/.pm2/logs/epwx-bot-out.log'

ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'tail -n 100 /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/profile-switch-cron.log'

ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'cat /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/profile-switch-state.env'
```

The connection diagnostic is read-only:

```bash
cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base
env -i HOME="$HOME" USER="$USER" PATH="$PATH" NODE_ENV=production \
  ENV_FILE="$PWD/.env" EXCHANGE_NAME=biconomy \
  node dist/scripts/test-exchange-connection.js
```

Do not run cancellation scripts as diagnostics.

## Immediate Next Actions

1. Keep `legit-market-making-sell-only-recovery` while spread remains materially above the 6% recovery threshold.
2. Monitor the three SELL orders for real fills and verify locked EPWX against remaining open quantity.
3. Watch the live auto-switch cron because a confirmed profile change restarts the bot and cancels/reseeds orders.
4. Before the next restart, verify the shared artifact hash and both exchange environment selectors.
5. Immediately after any restart, verify Biconomy service selection, dedicated Biconomy state loading, balances, open orders, buy pause, and self-trade-off policy.
6. Fix Jest runtime-state isolation before the next broad strategy release.
7. Keep Azbit and Biconomy deployment changes coordinated while both processes share one compiled `dist` tree.
