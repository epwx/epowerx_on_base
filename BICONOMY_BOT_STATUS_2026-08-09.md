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
profile=legit-market-making-sell-only-recovery
reason=manual switch
```

Important profile values from `profiles/legit-market-making-sell-only-recovery.env`:

```env
BUY_REACTIVATION_MODE=off
FORCE_BUY_PAUSE=true
DEX_PRICE_DISCOUNT_PERCENT=26
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=off
MAX_DEX_CEX_DRIFT_PERCENT=45
MAX_EXEC_SPREAD_PERCENT=600
MAX_EXECUTABLE_SPREAD_CIRCUIT_BREAKER_PERCENT=220
TARGET_ORDERS_PER_SIDE=3
TARGET_BUY_DEPTH_USD=0
TARGET_SELL_DEPTH_USD=6
ORDER_FREQUENCY=7000
QUOTE_CHURN_REFRESH_PER_SIDE=2
MAX_ORDER_AMOUNT_TOKENS=12000000000
CANCEL_ORDERS_ON_START=true
CANCEL_ORDERS_ON_STOP=false
```

The profile uses the Base Chainlink ETH/USD feed and has a static fallback configured. The actual RPC URL remains secret in `.env`.

## Automatic Profile Switching

Production cron is live and can apply profile changes:

```cron
*/2 * * * * cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base && AUTO_SWITCH_USE_SELL_ONLY_RECOVERY=true AUTO_SWITCH_EXIT_DISLOCATED_SPREAD_PERCENT=6 AUTO_SWITCH_CONFIRM_CYCLES=3 /usr/bin/flock -n /tmp/epwx-switch.lock ./scripts/switch-profile.sh --auto >> /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/profile-switch-cron.log 2>&1
```

Current behavior:

- Runs every 2 minutes.
- Uses a lock to prevent overlapping switches.
- Requires 3 confirming samples.
- Enters dislocated handling at spread `>= 18%`.
- Exits dislocated handling at spread `<= 6%`.
- Sell-only recovery is enabled in the automatic path.
- Recent samples were repeatedly `27.586%`.
- Cron retained `legit-market-making-sell-only-recovery` and performed no switch.

Unlike the Azbit cron, this Biconomy cron is not dry-run. A confirmed profile change updates `.env` and restarts `epwx-bot`. Because `CANCEL_ORDERS_ON_START=true`, that restart cancels and reseeds open orders.

## Current Market Snapshot

Read-only connection diagnostic at approximately 2026-08-09 10:56 UTC:

- Last price: `1.043e-10`
- Best bid: `8.12e-11`
- Best ask: `1.036e-10`
- Executable spread: approximately `27.586%`
- DEX EPWX price: approximately `8.4311e-11`
- Discounted DEX reference at 26%: approximately `6.2390e-11`
- DEX/CEX drift: approximately `32.48%`
- Configured drift limit: `45%`

The strategy considers the executable book too wide for direct book-mid anchoring and falls back to the Biconomy ticker mid around `9.24e-11` for placement calculations.

## Account and Orders

Read-only connection diagnostic at approximately 2026-08-09 10:56 UTC:

- EPWX total: `1560605204728.5`
- EPWX free: `1528531237290.5`
- EPWX locked: `32073967438`
- USDT total/free: `676.09202716`
- USDT locked: `0`
- Open orders: `3`
- Recent trades returned by the diagnostic: none

All three open orders were real SELL orders:

```text
SELL 10680114185 EPWX @ 1.037e-10
SELL 10679580259 EPWX @ 1.037e-10
SELL 10714272994 EPWX @ 1.037e-10
```

The sum of open SELL quantities matches the locked EPWX. No USDT is locked because BUY placement is paused.

## Current Runtime Behavior

Recent cycles showed:

- Biconomy ticker and order book reads succeeding.
- DEX pricing succeeding.
- `0` BUY and `3` SELL open orders before and after cleanup.
- Sell-side imbalance guard detecting `0/3` book imbalance.
- Buy-side prioritization being suppressed by `FORCE_BUY_PAUSE=true`.
- BUY placement also blocked by `BUY_REACTIVATION_MODE=off`.
- Self-trading disabled by `SELF_TRADE_MODE=off`.
- SELL target already satisfied, so no additional order was required.

This is expected behavior for the current sell-only recovery profile.

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
