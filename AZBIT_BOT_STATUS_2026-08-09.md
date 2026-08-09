# EPWX Azbit Bot Status - 2026-08-09

## Purpose

This is the handoff document for continuing work on `epwx-azbit-bot` in a new context window. It records the production safety state, deployed artifact differences, validation evidence, known issues, and next actions as of 2026-08-09 10:47 UTC.

## Executive Status

- Production host: `deployer@104.131.164.145`
- Production root: `/mnt/volume1_nyc3_1778885684099/epowerx_on_base`
- PM2 process: `epwx-azbit-bot`
- PM2 process ID: `20`
- Process created: `2026-08-09T10:41:31.838Z`
- Status at capture: `online`
- Restarts since creation: `0`
- Exchange: Azbit
- Pair: `EPWX_USDT`
- Active profile: `azbit-sell-only-recovery`
- Observation start: `2026-08-09 10:41 UTC`
- Intended review point: after `2026-08-10 10:41 UTC`

The process is running the strategy in read-only shadow mode. Live reads go to Azbit, while all exchange writes are simulated in memory.

## Mandatory Safety Invariants

These must remain true during the observation:

```env
AZBIT_READ_ONLY=true
AZBIT_SHADOW_MODE=true
RUNTIME_STATE_FILE=logs/runtime-pnl-state.azbit.json
FORCE_BUY_PAUSE=true
BUY_REACTIVATION_MODE=off
SELF_TRADE_ENABLED=false
SELF_TRADE_MODE=off
CANCEL_ORDERS_ON_START=false
CANCEL_ORDERS_ON_STOP=false
```

Do not set `AZBIT_READ_ONLY=false` as part of observation or troubleshooting. Do not remove `--dry-run` from the Azbit profile-switch cron.

## Secret Handling

- The Alchemy Base Mainnet URL exists only as `BASE_RPC_URL` in the server-local `.env.azbit`.
- Presence was verified without printing the value.
- Do not add `BASE_RPC_URL` to tracked profiles, logs, documentation, commands that echo values, or chat.
- `.env.azbit` remains mode `0600` and must not be overwritten by deployment.

## Public Chain Configuration

All three tracked Azbit profiles contain:

```env
EPWX_TOKEN_ADDRESS=0xeF5f5751cf3eCA6cC3572768298B7783d33D60Eb
EPWX_WETH_PAIR=0x9793d47dd47024ac4e1f17988d2e92da53a94541
```

Profiles:

- `profiles/azbit/azbit-conservative.env`
- `profiles/azbit/azbit-dislocated.env`
- `profiles/azbit/azbit-sell-only-recovery.env`

## Current Production Behavior

- The configured Base RPC and EPWX/WETH pair return a positive DEX price.
- Verified DEX price: approximately `8.428814046123648e-11` USD per EPWX.
- The configured 6% DEX discount produced approximately `7.923085203356228e-11`.
- Azbit executable book at the last sample:
  - best bid: `3.02e-11`
  - best ask: `9.999e-10`
  - executable spread: `3210.927%`
- The `650%` executable-spread circuit breaker correctly pauses every quote-placement cycle.
- Do not raise the spread breaker merely to force shadow placements. The current market is too dislocated for the sell-only profile to quote safely.
- Shadow accounting currently reports zero orders, zero fills, and zero PnL.

`ETH_USD_SOURCE=chainlink` currently has no feed address configured. The pricing utility logs a warning and uses its configured fallback path. The direct DEX probe still returned a valid positive price.

## Real Account State

Last independent forced non-shadow read-only diagnostic at approximately 2026-08-09 10:42 UTC:

- Azbit API connection: passed
- Real open orders: `0`
- USDT free: `50.21741963`
- USDT locked: `0.00000000`
- EPWX free: `988716730227.38085938`
- EPWX locked: `0.00000001`

The shadow process did not create real orders or lock funds.

## Profile Switching

Current state file:

```text
profile=azbit-sell-only-recovery
mode=apply
spread_percent=manual
```

Production cron remains decision-only:

```cron
*/2 * * * * cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base && /usr/bin/flock -n /tmp/epwx-azbit-switch.lock ./scripts/switch-azbit-profile.sh --auto --dry-run >> /mnt/volume1_nyc3_1778885684099/epowerx_on_base/logs/azbit-profile-switch.log 2>&1
```

The profile switcher merges profile values into `.env.azbit`, preserving server-only keys such as `BASE_RPC_URL` and Azbit credentials.

## Implemented Azbit Components

- `src/services/azbit-exchange.service.ts`
  - HMAC authentication
  - Correct open-order and partial-fill semantics
  - Authenticated `/api/user/deals` reconciliation
  - Minimum quote enforcement
  - Accurate cancellation counts
- `src/services/shadow-exchange.service.ts`
  - Delegates reads to live Azbit
  - Simulates writes in memory
  - Tracks virtual balance locks
  - Never invokes underlying write methods
- `src/services/exchange.factory.ts`
  - Creates Azbit or Biconomy service by configuration
  - Wraps Azbit with `ShadowExchangeService` when shadow mode is enabled
- `src/index.ts`
  - Plain Azbit read-only mode is health-only
  - Azbit read-only plus shadow mode permits strategy decisions
- `scripts/start-azbit.sh`
  - Isolated Azbit PM2 startup path
- `scripts/switch-azbit-profile.sh`
  - Isolated profile switching with dry-run by default

## Production Artifact State

Production is a selective deployment and is not a clean build of local HEAD.

- Local Git HEAD: `5013c6e Fix Azbit profile merge portability`
- Runtime log marker: `aae6168`
- Deployed strategy artifact:
  - `dist/strategies/volume-generation.strategy.js`
  - SHA-256: `c3e6e7832425a57b4930dcb1c9ac8f166bd21d0a6152ba87a4e3ce359234f1c0`

The deployed strategy artifact contains three required corrections relative to the older production artifact:

1. It uses `createExchangeService()` instead of directly constructing `BiconomyExchangeService`.
2. It honors `config.runtime.stateFile`, isolating Azbit state in `logs/runtime-pnl-state.azbit.json`.
3. It rejects non-finite or non-positive DEX prices before exchange quote logic.

Do not replace this artifact with the old compiled strategy. Doing so will reintroduce Biconomy routing and shared-state defects for Azbit shadow mode.

## Biconomy Isolation

The running Biconomy process `epwx-bot` was not restarted during Azbit deployment:

- PM2 process ID: `3`
- PID at last check: `872699`
- Created: `2026-08-09T04:19:59.129Z`
- Historical restart count: `165`
- Biconomy `.env` modification time: `2026-08-09 04:18:04 UTC`
- Active state file: `logs/runtime-pnl-state.biconomy.json`

Recent logs showed its existing loop continuing normally with Biconomy API calls. Its runtime remains buy-paused and self-trading is off.

Both PM2 processes share the on-disk compiled strategy path. The running Biconomy process has its prior code loaded in memory. On its next restart, it will load the exchange-factory, per-exchange state-path, and invalid-DEX safety changes described above. These are exchange-neutral safety corrections, but this shared-artifact effect must be remembered.

## Backups and Rollback

Retain these server backups:

- `/tmp/azbit-shadow-backup-6ace295`
- `/tmp/env.azbit.pre-shadow-6ace295`
- `/tmp/volume-generation.strategy.pre-factory-fix.js`
- `/tmp/azbit-dex-config-backup-20260809T1042`

Safest immediate rollback from strategy observation to health-only mode:

```bash
cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base
sed -i 's/^AZBIT_SHADOW_MODE=.*/AZBIT_SHADOW_MODE=false/' .env.azbit
chmod 600 .env.azbit
bash scripts/start-azbit.sh
```

This keeps `AZBIT_READ_ONLY=true`. Do not restore the old strategy artifact while shadow mode is enabled because the old artifact bypasses Azbit factory routing.

## Local Uncommitted Changes

At capture time, local HEAD is `5013c6e` and these intentional changes are uncommitted:

```text
M profiles/azbit/azbit-conservative.env
M profiles/azbit/azbit-dislocated.env
M profiles/azbit/azbit-sell-only-recovery.env
M src/strategies/__tests__/volume-generation.strategy.test.ts
M src/strategies/volume-generation.strategy.ts
```

The profile changes add the public token and pair addresses. The strategy change rejects non-positive/non-finite DEX prices. The test covers the `-1` DEX error sentinel.

## Validation Status

Passed locally:

```bash
npx tsc -p tsconfig.json --noEmit
npx jest src/strategies/__tests__/volume-generation.strategy.test.ts --runInBand -t "should stop the cycle when the DEX price fetch returns an error sentinel"
```

The complete strategy test file currently has an unrelated existing test-isolation failure. PnL tests load `logs/runtime-pnl-state.biconomy.json`; one expected `$5` unrealized PnL but received `$60`. Do not attribute that failure to the DEX sentinel change. Isolate runtime-state persistence in tests before using the full file as a clean gate.

Passed in production:

- Production artifact syntax check
- Production constructor resolved `ShadowExchangeService`
- Production runtime state resolved `logs/runtime-pnl-state.azbit.json`
- Private RPC presence check without displaying the URL
- Direct production DEX probe returned a positive price
- PM2 remained online with zero restarts
- Independent real-account diagnostic returned zero open orders
- Strategy used the positive DEX price and stopped at the executable-spread circuit breaker

## Safe Monitoring Commands

Run from a trusted terminal. These commands do not print the RPC URL or credentials.

```bash
ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'pm2 describe epwx-azbit-bot'

ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'tail -n 100 /home/deployer/.pm2/logs/epwx-azbit-bot-out.log'

ssh -i ~/.ssh/epwx_server deployer@104.131.164.145 \
  'grep ^AZBIT_READ_ONLY= /mnt/volume1_nyc3_1778885684099/epowerx_on_base/.env.azbit; grep ^AZBIT_SHADOW_MODE= /mnt/volume1_nyc3_1778885684099/epowerx_on_base/.env.azbit'
```

For a real-order count, run the connection diagnostic with `AZBIT_SHADOW_MODE=false` only in that diagnostic process. Do not change persistent `.env.azbit`:

```bash
cd /mnt/volume1_nyc3_1778885684099/epowerx_on_base
env -i HOME="$HOME" USER="$USER" PATH="$PATH" NODE_ENV=production \
  ENV_FILE="$PWD/.env.azbit" EXCHANGE_NAME=azbit \
  AZBIT_READ_ONLY=true AZBIT_SHADOW_MODE=false \
  node dist/scripts/test-exchange-connection.js
```

## Next Actions

1. Keep the process in read-only shadow mode through the observation window.
2. Review PM2 restart count, DEX failures, circuit-breaker decisions, shadow orders/fills, and real Azbit open orders after 24 hours.
3. Do not weaken the 650% spread breaker while the executable spread is above 3000%.
4. Fix test runtime-state isolation so the complete strategy suite becomes deterministic.
5. Commit the five intentional local code/profile changes plus this handoff document after review.
6. Before any future writable canary, require explicit approval and re-verify `0` real open orders, balances, minimum quote amount, and cancellation behavior.
