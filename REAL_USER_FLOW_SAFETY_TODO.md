# Real User Flow Safety TODO

## Goal
Harden the EPWX market-making strategy so real user buy and sell flow is handled safely, profitably when possible, and with test coverage for each behavior change.

## Working Rules
- Implement one item at a time.
- Add or update tests for each item before moving to the next one.
- Validate each change with the smallest relevant test scope first.
- Avoid mixing quoting, inventory, and PnL refactors in the same step unless required by the implementation.

## Todo Items

### 1. Make CEX executable prices the primary live quote anchor
Status: Completed on 2026-07-22

Objective:
- Use the executable Biconomy book or a safe CEX-derived mid-price for normal quote placement.
- Keep DEX price as a reference and guardrail, not the default live quote anchor.

Implementation notes:
- Review the current `priceReference` and `washPriceReference` split.
- Only fall back to DEX reference when the CEX book is unusable and the fallback is explicitly allowed.
- Keep logging clear about which anchor is active each cycle.

Tests:
- Add a test proving quotes use executable CEX mid when bid/ask are valid.
- Add a test proving DEX is not used for normal placements when executable CEX prices are available.
- Add a test for the fallback path when executable CEX prices are missing or too wide.

Acceptance criteria:
- Normal buy and sell placements use the CEX-derived anchor whenever the executable book is valid.
- DEX reference remains available for comparison and guard checks.

Implementation notes:
- Added a dedicated placement-price selector in the strategy.
- Normal placements now prefer executable orderbook mid, then CEX ticker mid, then DEX fallback.
- Added focused Jest coverage for executable-mid selection, ticker-mid fallback, and DEX-only fallback.

### 2. Remove marketable top-touch quote behavior
Status: Completed on 2026-07-22

Objective:
- Stop placing top-touch buy orders directly at best ask and sell orders directly at best bid unless an explicitly aggressive mode is enabled.

Implementation notes:
- Replace current top-touch logic with passive offsets.
- Ensure new touch quotes rest on the book instead of crossing immediately.
- Keep quote discovery behavior configurable if needed.

Tests:
- Add a test proving the buy touch price is below or equal to best bid in passive mode.
- Add a test proving the sell touch price is above or equal to best ask in passive mode.
- Add a test proving no immediate crossing orders are submitted in default mode.

Acceptance criteria:
- Default top-of-book behavior is passive.
- Aggressive crossing is not used unless intentionally configured.

Implementation notes:
- Added a passive top-touch selector in the strategy.
- Top-touch buys now rest on the bid side and top-touch sells rest on the ask side.
- Added focused Jest coverage for passive buy touch, passive sell touch, and non-crossing defaults.

### 3. Apply DEX/CEX drift protection to all live quoting
Status: Completed on 2026-07-22

Objective:
- Extend drift protection so large DEX/CEX divergence can pause or restrict normal quote placement, not only wash trades.

Implementation notes:
- Reuse the existing drift calculation and threshold configuration.
- Decide whether the safe response is full pause, reduced-size quoting, or CEX-only quoting.
- Log the reason for any quote suppression clearly.

Tests:
- Add a test proving new quote placement is blocked or reduced when drift exceeds threshold.
- Add a test proving quoting resumes when drift returns inside limits.
- Add a test proving wash-trade behavior still follows the same drift guard.

Acceptance criteria:
- Excessive drift prevents unsafe live quoting.
- Behavior is deterministic and visible in logs.

Implementation notes:
- Added a dedicated live-quote drift decision helper in the strategy.
- High drift now pauses wash trades as before, and also blocks live quote placement when quoting would fall back to DEX.
- When a CEX price anchor exists during high drift, the bot stays in a CEX-only quoting mode instead of reverting to DEX-based live quotes.
- Added focused Jest coverage for paused DEX-fallback quoting, allowed CEX-only quoting, and normal quoting within threshold.

### 4. Add inventory-aware quote skew after real user fills
Status: Completed on 2026-07-22

Objective:
- Skew future quotes based on inventory imbalance created by real user fills before full rebalance is required.

Implementation notes:
- If the bot becomes long EPWX, reduce bid aggressiveness and improve ask aggressiveness.
- If the bot becomes short EPWX, reduce ask aggressiveness and improve bid aggressiveness.
- Keep this separate from the hard position rebalance threshold.

Tests:
- Add a test proving long inventory widens or lowers bids and/or improves asks.
- Add a test proving short inventory widens or raises bids and/or reduces ask aggressiveness.
- Add a test proving neutral inventory keeps symmetric quote behavior.

Acceptance criteria:
- Quote placement responds to inventory drift before hard rebalance kicks in.
- Inventory skew is measurable and predictable in tests.

Implementation notes:
- Added configurable inventory skew settings and a reusable quote-price skew helper in the strategy.
- Live quoting now shifts downward when the bot is long EPWX and upward when the bot is short EPWX, before the hard rebalance threshold is reached.
- Applied the skew across passive top-touch prices, depth-support prices, and seeded book-depth prices.
- Added focused Jest coverage for long inventory, short inventory, and neutral inventory quote behavior.

### 5. Tighten and formalize passive quote bands
Status: Completed on 2026-07-22

Objective:
- Replace broad percentage bands with clearer passive quote offsets around the active fair-value anchor.

Implementation notes:
- Review current 98%-100% buy and 100%-102% sell depth bands.
- Move to smaller configurable offsets suitable for passive market making.
- Keep enough spacing for depth layering without creating obviously stale quotes.

Tests:
- Add a test proving seeded buy orders remain below the active anchor by configured offsets.
- Add a test proving seeded sell orders remain above the active anchor by configured offsets.
- Add a test proving quote layers stay ordered and do not overlap.

Acceptance criteria:
- Passive quote bands are narrower, configurable, and symmetric unless inventory skew applies.
- Layered orders remain ordered and non-crossing.

Implementation notes:
- Replaced the hard-coded 98%-100% and 100%-102% bands with explicit passive band configuration.
- Added reusable helpers for passive band boundaries and seeded quote-layer prices.
- Tightened default passive depth bands to 99.60%-100.00% for buys and 100.00%-100.40% for sells, with seeded layers around 0.10%-0.39% from the active anchor.
- Applied the new helpers across support-depth quotes and seeded book-depth quotes.
- Added focused Jest coverage for passive band boundaries and seeded non-overlapping layer ordering.

### 6. Replace the current real-fill profit metric with true trading PnL tracking
Status: Completed on 2026-07-22

Objective:
- Track economically meaningful PnL for real user fills instead of comparing fill price only against the intended order price.

Implementation notes:
- Separate realized spread capture from unrealized inventory mark-to-market.
- Distinguish wash-trade accounting from real-user trading performance.
- Define the fair-value source used for mark-to-market calculations.

Tests:
- Add a test for realized PnL on a completed buy-then-sell round trip.
- Add a test for unrealized PnL on inventory held after one-sided fills.
- Add a test proving wash-trade volume does not inflate real-user PnL.

Acceptance criteria:
- Reported PnL reflects real trading outcome, not just order-price deltas.
- Real-user and wash-trade metrics are clearly separated.

Implementation notes:
- Replaced fill-vs-intended-price pseudo-profit with signed inventory cost-basis accounting.
- Added realized PnL, unrealized mark-to-market PnL, total PnL, real-fill realized PnL, average realized PnL per real fill, best realized fill PnL, and inventory mark/cost-basis tracking.
- Wash trades no longer inflate real-user PnL metrics.
- Mark price now updates from the active quote reference and from real fills for inventory valuation.
- Added focused Jest coverage for realized round-trip PnL, one-sided unrealized PnL, and wash-trade exclusion from real-user PnL.

## Suggested Implementation Order
1. Primary quote anchor
2. Passive top-touch behavior
3. Drift protection for all quoting
4. Inventory-aware quote skew
5. Passive quote band tightening
6. Real PnL tracking

## Primary Files Likely To Change
- `src/strategies/volume-generation.strategy.ts`
- `src/strategies/__tests__/volume-generation.strategy.test.ts`
- `src/strategies/__tests__/dex-biconomy-diff.test.ts`
- `src/config/index.ts`

## Validation Approach
- Prefer targeted Jest tests for the touched behavior.
- Use `npx tsc -p tsconfig.json` after code changes when test coverage alone is not enough.
- Keep each step small enough that failures clearly identify the broken assumption.

## Post-Implementation Deployment Todo

### 7. Prepare a safe droplet verification `.env` profile
Status: Pending

Objective:
- Define a low-risk runtime configuration for the first production-like verification run on the droplet.

Implementation notes:
- Start with `SELF_TRADE_ENABLED=false`.
- Use smaller `MIN_ORDER_SIZE` and `MAX_ORDER_SIZE` values than production.
- Use a slower `ORDER_FREQUENCY` than production.
- Keep position and loss controls enabled for the first verification run.

Verification goals:
- Confirm the bot starts cleanly with the new quote-anchor, drift, skew, band, and PnL logic.
- Confirm inventory and PnL logs move in the expected direction during a short run.

### 8. Prepare exact droplet deployment and smoke-test commands
Status: Pending

Objective:
- Document the exact commands to deploy, verify connectivity, start the bot, and inspect the first runtime signals safely.

Implementation notes:
- Include branch update or checkout commands.
- Include dependency install and build steps if required.
- Include `npm run test:connection` before starting the bot.
- Include the bot start command and log-inspection commands.

Verification goals:
- Confirm API connectivity, balances, order book access, and startup behavior before longer runtime exposure.

### 9. Review deployment script order and rollout safety
Status: Pending

Objective:
- Inspect the current deployment scripts and confirm the safest rollout sequence for the updated bot.

Implementation notes:
- Review `deploy.sh` and `update-bot.sh`.
- Confirm backup order, stop/start order, build order, and rollback points.
- Identify any script assumptions that could be unsafe with the new runtime behavior.

Verification goals:
- Ensure the rollout sequence preserves rollback paths and minimizes production risk.

### 10. Add configurable low-liquidity rollout book caps
Status: Completed on 2026-07-23

Objective:
- Prevent small-balance observation runs from silently growing toward the default production book-size targets.

Implementation notes:
- Make target orders per side configurable instead of fixed at `30`.
- Make target buy depth and target sell depth configurable instead of fixed at `$200` each.
- Keep production defaults unchanged while allowing much smaller caps for cautious first-run deployments.

Tests:
- Add a test proving cleanup respects a lower configured target order count.
- Add a test proving a low-liquidity rollout cycle does not place extra depth orders beyond the configured per-side cap.

Acceptance criteria:
- A small-balance deployment can cap total live orders and book depth through `.env` without changing code again.
- Default behavior remains backward compatible for existing production profiles.

Implementation notes:
- Added `TARGET_ORDERS_PER_SIDE`, `TARGET_BUY_DEPTH_USD`, and `TARGET_SELL_DEPTH_USD` config values.
- Replaced the hard-coded `30` orders-per-side target and `$200` per-side depth targets with those config values in the strategy.
- Preserved previous production behavior through unchanged defaults while enabling true low-liquidity observation profiles.

### 11. Validate real-user fill handling under wash-off mode
Status: Completed on 2026-07-24

Objective:
- Confirm a real external user fill is processed cleanly with `SELF_TRADE_ENABLED=false`, including fill detection, inventory update, and PnL tracking.
- Ensure no rebalance/cancel storm behavior returns after the latest fixes.

Implementation notes:
- Live rollout exposed a rebalance loop where repeated rebalance checks triggered frequent `cancelAllOrders` + rebalance buys in short succession.
- Added rebalance throttling controls and guard rails in commit `edf6e30`.
- New runtime control added: `REBALANCE_COOLDOWN_MS` (deployed at `45000` for current validation run).
- Confirmed post-deploy logs no longer show the prior rapid rebalance recursion pattern.

Tests:
- Added strategy regression coverage for rebalance cooldown behavior.
- Added regression coverage to keep normalization caps from expanding past static limits.
- Re-ran focused Jest strategy suite and TypeScript compile checks after the change.

Acceptance criteria:
- Real-user fill events increment real-fill counters and update inventory/PnL once per observed fill lifecycle.
- Rebalance actions are rate-limited and do not trigger repeated cancel/rebuy storms.
- Open-order maintenance remains bounded by configured caps during and after rebalance activity.

Observed production outcomes:
- Build marker for `edf6e30` confirmed active in runtime logs.
- Real fill path validated in production: fill detection fired, inventory changed, and PnL metrics updated.
- Runtime stats reflected live fill impact (`Real Fills: 1`, non-zero position, non-zero unrealized PnL) after the external execution test.
- Rebalance throttling behaved as intended during live fills (`Rebalance already in progress` and cooldown logs observed, without prior rebalance storm recurrence).
- Intermittent exchange API unavailability (`Service is not available`) still occurs and should be treated as an external reliability caveat during validation windows.

### 12. Tune token-cap sizing for tiny-price EPWX markets
Status: Completed on 2026-07-24

Objective:
- Keep per-order USD notional practical at low token prices by preventing premature token-cap clipping.

Implementation notes:
- Initial runtime setting `MAX_ORDER_AMOUNT_TOKENS=8000000000` clipped many orders too early, reducing effective notional and causing repeated cap/skip warnings.
- Increased runtime setting to `MAX_ORDER_AMOUNT_TOKENS=40000000000` for current production validation.
- Post-change logs show materially more placements in the `36B-40B` token range, improving depth progression while preserving cap safety.

### 13. Pause futile buy placement loops when reserve-constrained spendable USDT is too low
Status: Completed on 2026-07-24

Objective:
- Prevent repeated per-order buy attempts when `availableUSDT - IDLE_BALANCE_RESERVE_USD` is below minimum order notional.
- Reduce repetitive warning noise and keep cycle behavior deterministic under tight reserve conditions.

Implementation notes:
- Added a cycle-level buy feasibility gate in the strategy based on reserve-constrained spendable USDT.
- When spendable USDT is below minimum notional, buy placement paths are skipped for the current cycle.
- Added a single cycle summary warning (`Buy placements paused this cycle...`) instead of repeated per-order skip warnings.
- Ensured sell-side imbalance buy-priority logic does not force buy-path attempts when reserve gating disables buys.

Tests:
- Added a regression test proving buy placement loops are skipped when spendable USDT after reserve is below minimum notional.
- Added a regression assertion for the single summary warning behavior.
- Re-ran focused strategy suite and full project suite after patching.

Acceptance criteria:
- No repeated futile buy placement attempts occur in cycles where spendable reserve-constrained USDT is below minimum notional.
- Logging remains concise and explanatory with one cycle-level warning for the gating condition.
- Existing strategy behavior remains regression-safe.

Validation outcomes:
- Focused strategy suite passed (`56/56`).
- Full Jest suite passed (`110/110`).
- Changes committed and pushed in commit `e6f8c1b`.

Post-deploy checks:
- Verify production logs show cycle-level pause warnings instead of repeated per-order reserve skip spam.
- Confirm sell-side maintenance still proceeds while buy paths remain safely gated under low spendable balance.

Acceptance criteria:
- Cap warnings become occasional safety events rather than dominant sizing behavior.
- Book depth progresses toward configured targets with fewer under-sized placements.
- No regression in order-count/depth caps or drift-guard behavior.

Observed production outcomes:
- Runtime repeatedly capped into the `36B-40B` range as expected with improved per-order notional versus the prior `8B` cap setting.
- Order-count and depth controls remained bounded during the same windows (`4x4` target behavior and depth progression toward configured limits).

### 13. Add rebalance execution price guard for abnormal-book conditions
Status: Completed on 2026-07-24 (spread+deviation production validated)

Objective:
- Prevent rebalance orders from executing at clearly unsafe prices during temporary orderbook dislocations or thin-book anomalies.

Implementation notes:
- Live validation exposed a rebalance-driven sell placed at a significantly discounted price during abnormal book conditions.
- Added rebalance quote sanitization that normalizes ticker bid/ask ordering before price selection.
- Added spread guard and mark-deviation guard prior to `cancelAllOrders`, so unsafe rebalance attempts are skipped without wiping the book.
- Added configurable thresholds: `REBALANCE_MAX_SPREAD_PERCENT` and `REBALANCE_MAX_PRICE_DEVIATION_PERCENT`.
- Guard decisions now log explicit skip reasons with computed percentages and threshold values.

Tests:
- Added a test proving rebalance sell is suppressed when quote deviation exceeds the configured threshold.
- Added a test proving rebalance is suppressed when ticker spread exceeds the configured threshold.
- Added a test proving rebalance still executes when spread and quote deviation are within guard limits.

Acceptance criteria:
- No rebalance order is sent at a price that violates configured spread or deviation safeguards.
- Position reduction remains functional without reverting to rebalance storm behavior.
- Post-fill inventory recovery continues to respect order-count, depth, and drift controls.

Observed production outcomes:
- Rebalance trigger observed in production logs: `Position rebalance needed: -35003431708.90`.
- New spread guard fired as expected and blocked unsafe execution: `Skipping rebalance because ticker spread is too wide (19.40% > 5.00%)`.
- Cooldown and in-progress protections remained active after the blocked rebalance attempt (`Rebalance already in progress` and cooldown messages observed).
- Real BUY flow remained healthy in the same validation window (real fill detection, inventory updates, and continued bounded quote maintenance).
- Real SELL flow was validated in a follow-up live window, including sell fill detection, positive realized PnL progression, and stable post-fill orderbook maintenance under configured caps.
- Position recovery behavior remained bounded after buy/sell activity, with inventory moving toward neutral and skew logic continuing to adjust quotes without triggering unsafe rebalance execution.
- Intermittent exchange API outages (`Service is not available`) were observed during the same period and should be treated as an external reliability caveat, not a guard-logic regression.
- Deviation-guard branch was validated in production using a temporary strict threshold run (`REBALANCE_MAX_SPREAD_PERCENT=30`, `REBALANCE_MAX_PRICE_DEVIATION_PERCENT=0.5`), with explicit skip evidence: `Skipping rebalance BUY because quote deviation is too high (8.78% > 0.50%; ...)` and `... (9.15% > 0.50%; ...)`.
- Cooldown behavior remained correct after deviation-guard skips (`Rebalance cooldown active ...`) and regular order-placement/fill maintenance continued without rebalance storm recurrence.
- After validation, production-safe guard values were restored to `REBALANCE_MAX_SPREAD_PERCENT=5` and `REBALANCE_MAX_PRICE_DEVIATION_PERCENT=5`.

### 14. Add exchange-band-aware sell placement guard
Status: Completed on 2026-07-25 (implemented via guarded fallback sell pricing + live validation)

Objective:
- Prevent repeated sell-order rejects when the exchange rejects a passive price as outside the latest-price band.
- Keep the book balanced without hammering the exchange with the same invalid sell price.

Implementation notes:
- Live logs show repeated sell placement failures with `The price must be between <?>% and <?>% of the latest price` while buy placement continues.
- The current fallback to CEX ticker mid is not sufficient by itself when the derived sell price still lands outside the exchange's allowed band.
- Add a pre-check in sell placement that compares the intended price against the exchange-allowed latest-price window and either clamps the price or skips that placement for the cycle.
- Keep rebalance, drift, and cooldown guards unchanged; this is a placement-level safety guard.

Tests:
- Add a test proving sell placement clamps or skips when the intended price violates the exchange band.
- Add a test proving valid sell placements still proceed when within band.
- Add a test proving the strategy does not retry the same invalid sell price repeatedly in one cycle.

Acceptance criteria:
- Sell placement no longer loops on exchange-band rejects.
- Book maintenance can continue without repeated sell-side error spam.
- The strategy remains passive and exchange-compliant under wide-book conditions.

Validation outcomes:
- Latest production windows show exchange-band fallback sell pricing active during dislocation cycles.
- Recent logs no longer show repeated `The price must be between <?>% and <?>% of the latest price` sell reject loops.
- Sell-side maintenance remained active while buy-side gating stayed conservative.

### 15. Add profitability-gated buy reactivation mode (safety-first)
Status: In progress on 2026-07-25 (phase-2 code complete and deployed; production remains in safety-lock due to dislocated market conditions)

Objective:
- Allow the bot to pursue profit only when expected post-fee edge is positive and market-quality conditions are healthy.
- Keep all existing safety controls as first-class constraints, with automatic rollback to defensive mode when risk rises.

Implementation notes:
- Add a new mode (for example `BUY_REACTIVATION_MODE=off|auto|on`) and keep `FORCE_BUY_PAUSE` as the hard override.
- In `auto` mode, permit buy placements only when all gates pass in the same cycle:
	- expected net edge >= configured minimum edge threshold
	- executable spread <= max spread threshold
	- DEX/CEX drift <= drift threshold for two-sided quoting
	- minimum executable depth exists on both sides
	- adverse-fill guard is not active
- If any gate fails, degrade automatically to defensive behavior (buy pause or size reduction) and log explicit reasons.
- Keep wash-trade behavior unchanged (`SELF_TRADE_ENABLED=false` remains authoritative).

Latest implementation progress (now active in code):
- Added config + strategy support for `BUY_REACTIVATION_MODE` (`off|auto|on`).
- Added `MIN_NET_EDGE_BPS` gate wiring.
- Added `MAX_EXEC_SPREAD_PERCENT` gate wiring.
- Added strategy regression coverage for:
- buys suppressed in `off` mode while sell maintenance continues.
- buys suppressed in `auto` mode when spread exceeds threshold.
- buys allowed in `auto` mode when spread/edge checks pass.
- Added sell-freeze protection that suppresses new sell placements when buys are gated and `TARGET_SELL_DEPTH_USD=0`, including skipping the sell clamp probe in frozen cycles.
- Added regression coverage proving the freeze path does not emit the exchange-band fallback warning.

Latest production validation outcomes:
- With `FORCE_BUY_PAUSE=false`, buy policy pause was successfully removed (phase-2 unlock confirmed).
- BUY placements remained safely blocked by reactivation gate in live dislocation windows: `spread 19.40% > 8.00%`.
- Executable-book spread remained ~15.01% and DEX/CEX drift ~31%, so drift guard and wash-trade pauses behaved as expected.
- Runtime maintained sell-side fallback maintenance while preventing unsafe buy reactivation.
- Duplicate reserve env override issue was cleaned up; no new reserve-warning spam observed in latest validated log windows.
- Latest droplet cadence tuning set both `ORDER_FREQUENCY` and `UPDATE_INTERVAL` to `15000`, which removed the earlier overlap/noise pattern while keeping the bot in freeze-safe mode.

Latest runtime re-validation (2026-07-25, post-redeploy):
- Runtime remained stable on the `15000ms` loop cadence over multi-hour observation windows.
- Auto gate diagnostics continuously report high drift lockout (`DEX/CEX drift ~31.5% > 3.0%`) and keep BUY side paused deterministically.
- Executable-book spread remained extreme (~690.53% in the latest sample), so fallback to CEX ticker mid remained active by design.
- Book shape repeatedly stabilized at `0 buys / 0 sells` during the latest freeze-only window, with sell depth explicitly held at `0.00 / 0.00` because `TARGET_SELL_DEPTH_USD=0` and buys were gated.
- Volume/PnL stayed near zero in this window (`Real fills: 0`), consistent with safety-first no-trade behavior under current market dislocation.
- No evidence of accidental marketable BUY or SELL execution in this regime.
- Live logs still show the wide-spread placement fallback warning when the executable book is unusable, but the separate sell-freeze warning now prevents new sell placement attempts during frozen cycles.

Current operator decision point:
- Keep current strict gates if priority is loss-avoidance while market quality is poor.
- Only begin staged relaxation (drift threshold and minimal activity reintroduction) after sustained improvement in executable spread and DEX/CEX convergence.

Config additions (proposed):
- `BUY_REACTIVATION_MODE` (`off`, `auto`, `on`) default `off`
- `MIN_NET_EDGE_BPS` minimum expected post-fee edge required to place risk
- `MAX_EXEC_SPREAD_PERCENT` maximum spread tolerated for normal two-sided quoting
- `MIN_EXEC_DEPTH_BUY_USD` and `MIN_EXEC_DEPTH_SELL_USD` required executable depth near quote bands
- `ADVERSE_FILL_RATIO_MAX` rolling cap before buy-side is throttled/paused
- `RISK_SIZE_MULTIPLIER_DEFENSIVE` and `RISK_SIZE_MULTIPLIER_NORMAL` for dynamic sizing

Recommended initial parameter values (first live rollout profile):

| Parameter | Suggested initial value | Why this is safe for first rollout |
| --- | --- | --- |
| `FORCE_BUY_PAUSE` | `true` at deploy; move to `false` only after setting `BUY_REACTIVATION_MODE=auto` | Keeps emergency hard-stop active until gates are verified. |
| `BUY_REACTIVATION_MODE` | `auto` | Prevents blind buy reactivation and requires all risk gates to pass. |
| `MIN_NET_EDGE_BPS` | `80` | Requires clear post-fee edge before placing buy risk; avoids noise trading. |
| `MAX_EXEC_SPREAD_PERCENT` | `8.0` | Blocks two-sided quoting in extreme dislocation while allowing moderate spreads. |
| `DRIFT_THRESHOLD_PERCENT` | `3.0` (existing) | Keeps DEX/CEX divergence guard strict and unchanged from current safety baseline. |
| `MIN_EXEC_DEPTH_BUY_USD` | `20` | Avoids quoting into thin bid conditions where fills are easier to pick off. |
| `MIN_EXEC_DEPTH_SELL_USD` | `20` | Requires minimum sell-side liquidity symmetry before enabling buy risk. |
| `ADVERSE_FILL_RATIO_MAX` | `1.5` | If real BUY fills outpace SELL fills too much, auto-throttle/auto-pause buy side. |
| `RISK_SIZE_MULTIPLIER_DEFENSIVE` | `0.35` | Uses reduced notional during unstable regimes to cap loss velocity. |
| `RISK_SIZE_MULTIPLIER_NORMAL` | `0.60` | Starts below full size even in healthy regimes; scale up only after evidence. |
| `SESSION_STOP_LOSS_USD` | `-15` | Hard intra-session protection against prolonged adverse conditions. |
| `DAILY_STOP_LOSS_USD` | `-40` | Daily brake to prevent repeated restarts from compounding loss. |
| `CONSECUTIVE_ADVERSE_FILLS_MAX` | `3` | Fast guard against short streaks of toxic flow. |
| `ADVERSE_FILL_COOLDOWN_MINUTES` | `30` | Forces time-based cooling before buy-side resumes. |
| `MAX_LONG_INVENTORY_USD` | `120` | Caps one-sided long accumulation while buy side is being reintroduced. |
| `MAX_SHORT_INVENTORY_USD` | `120` | Symmetric short-risk bound during early profit-mode rollout. |

Rollout note:
- Start with `BUY_REACTIVATION_MODE=auto` and defensive multipliers only.
- Require a statistically meaningful sample of real fills with positive net realized PnL before increasing `RISK_SIZE_MULTIPLIER_NORMAL` toward `1.0`.
- Keep `FORCE_BUY_PAUSE` available as immediate rollback if drawdown or adverse-fill breakers trigger.

Section 15 phase-2 execution checklist (implementation-first):

1. Add missing config keys and parser wiring in `src/config/index.ts`:
- `MIN_EXEC_DEPTH_BUY_USD`
- `MIN_EXEC_DEPTH_SELL_USD`
- `RISK_SIZE_MULTIPLIER_DEFENSIVE`
- `RISK_SIZE_MULTIPLIER_NORMAL`
- `ADVERSE_FILL_RATIO_MAX`

Acceptance for step 1:
- Runtime starts safely with defaults when new keys are absent.
- Invalid env values do not unlock buy risk unexpectedly.

2. Add remaining `auto`-mode gate logic in `src/strategies/volume-generation.strategy.ts`:
- Depth gate: enforce minimum executable depth on both sides.
- Adverse-flow gate: block buys when real BUY fills dominate real SELL fills beyond ratio threshold.
- Keep spread and edge gates active and combine all gate outputs into a deterministic cycle decision.

Acceptance for step 2:
- In `auto`, BUY budget is enabled only when all gates pass.
- Any single gate failure suppresses BUY placements for that cycle.
- Logs include explicit pass/fail reasons per gate.

3. Add dynamic risk sizing based on market regime in `src/strategies/volume-generation.strategy.ts`:
- Use `RISK_SIZE_MULTIPLIER_DEFENSIVE` during marginal-but-allowed conditions.
- Use `RISK_SIZE_MULTIPLIER_NORMAL` only in healthy conditions with stronger confirmation.
- Clamp multipliers to a safe range so sizing never bypasses existing hard caps.

Acceptance for step 3:
- Per-order notional shrinks in defensive regime and scales up only in healthier regimes.
- Hard safety controls (caps/reserve/position limits) still dominate final sizing.

4. Add Section 15 regression tests in `src/strategies/__tests__/volume-generation.strategy.test.ts`:
- Buys blocked when executable depth is below configured minima.
- Buys blocked when adverse fill ratio exceeds threshold.
- Buys allowed only when spread, edge, depth, and adverse-flow gates all pass.
- Defensive multiplier and normal multiplier paths both validated.
- Sell maintenance remains active when buys are gated.

Acceptance for step 4:
- New focused tests pass and existing suite remains regression-clean.

5. Update rollout template in `.env.example` with phase-2 keys and safe defaults.

Suggested initial values for phase-2 rollout:
- `BUY_REACTIVATION_MODE=auto`
- `MIN_NET_EDGE_BPS=80`
- `MAX_EXEC_SPREAD_PERCENT=8`
- `MIN_EXEC_DEPTH_BUY_USD=20`
- `MIN_EXEC_DEPTH_SELL_USD=20`
- `ADVERSE_FILL_RATIO_MAX=1.5`
- `RISK_SIZE_MULTIPLIER_DEFENSIVE=0.35`
- `RISK_SIZE_MULTIPLIER_NORMAL=0.60`

6. Validation and deployment sequence:
- Run focused strategy tests first.
- Run full Jest suite.
- Run TypeScript check: `npx tsc -p tsconfig.json --noEmit`.
- Deploy with `FORCE_BUY_PAUSE=true` to verify no accidental buy placements.
- Switch to `FORCE_BUY_PAUSE=false` while keeping `BUY_REACTIVATION_MODE=auto`.

Acceptance for step 6:
- Phase 1 (`FORCE_BUY_PAUSE=true`): zero BUY placements, sell maintenance active.
- Phase 2 (`FORCE_BUY_PAUSE=false`): BUYs appear only in cycles where all `auto` gates pass.
- High drift/high spread windows still block BUYs deterministically.

Go/No-Go production criteria for profit-mode continuation:
- Go only if auto-gate pass cycles show non-negative realized PnL trend over meaningful real-fill sample size.
- Go only if adverse-fill guard does not repeatedly trip after unlock.
- Go only if inventory stays within configured risk bands without repeated emergency suppression.
- No-Go if drawdown exceeds session tolerance or if gate behavior becomes inconsistent; revert immediately with `FORCE_BUY_PAUSE=true`.

Ready-to-paste `.env` rollout profile (supported by current code):

```env
# Safety-first profit rollout (current code-compatible)
# Keep this block near your runtime strategy settings.

# Hard safety overrides
FORCE_BUY_PAUSE=true
SELF_TRADE_ENABLED=false

# Core cadence and quoting
ORDER_FREQUENCY=5000
SPREAD_PERCENTAGE=0.10
MAX_DEX_CEX_DRIFT_PERCENT=3
PAUSE_WASH_ON_HIGH_DRIFT=true

# Reserve and utilization
IDLE_BALANCE_RESERVE_USD=140
BALANCE_UTILIZATION_PERCENT=0.92

# Order sizing and caps
MIN_ORDER_SIZE=5
MAX_ORDER_SIZE=20
MAX_ORDER_AMOUNT_TOKENS=40000000000

# Book shaping caps
TARGET_ORDERS_PER_SIDE=2
TARGET_BUY_DEPTH_USD=10
TARGET_SELL_DEPTH_USD=25

# Passive quote bands
PASSIVE_BUY_BAND_OUTER_OFFSET_PERCENT=0.004
PASSIVE_BUY_BAND_INNER_OFFSET_PERCENT=0
PASSIVE_SELL_BAND_INNER_OFFSET_PERCENT=0
PASSIVE_SELL_BAND_OUTER_OFFSET_PERCENT=0.004
PASSIVE_SEED_BASE_OFFSET_PERCENT=0.001
PASSIVE_SEED_STEP_OFFSET_PERCENT=0.0001

# Rebalance protections
REBALANCE_COOLDOWN_MS=45000
REBALANCE_MAX_SPREAD_PERCENT=5
REBALANCE_MAX_PRICE_DEVIATION_PERCENT=5

# Risk baseline
ENABLE_POSITION_LIMITS=true
DAILY_LOSS_LIMIT=1000
MAX_SLIPPAGE=0.5
```

Planned next-step keys (not yet implemented in code; documenting target only):

```env
# These are roadmap keys for Section 15 implementation work.
# They will have no effect until parser + strategy logic are added.

BUY_REACTIVATION_MODE=auto
MIN_NET_EDGE_BPS=80
MAX_EXEC_SPREAD_PERCENT=8
MIN_EXEC_DEPTH_BUY_USD=20
MIN_EXEC_DEPTH_SELL_USD=20
ADVERSE_FILL_RATIO_MAX=1.5
RISK_SIZE_MULTIPLIER_DEFENSIVE=0.35
RISK_SIZE_MULTIPLIER_NORMAL=0.60
SESSION_STOP_LOSS_USD=-15
DAILY_STOP_LOSS_USD=-40
CONSECUTIVE_ADVERSE_FILLS_MAX=3
ADVERSE_FILL_COOLDOWN_MINUTES=30
MAX_LONG_INVENTORY_USD=120
MAX_SHORT_INVENTORY_USD=120
```

Sizing and inventory safety:
- Enforce hard inventory bands (max long/max short) and block the side that worsens inventory at the band edge.
- Use volatility/drift-aware notional scaling: smaller size in unstable regimes, larger size only after sustained healthy metrics.
- Keep reserve protections and minimum-notional guards unchanged.

Circuit breakers:
- Add session and daily drawdown stops for new order placement.
- Add consecutive adverse-fill stop with cooldown before reactivation.
- On breaker trigger: disable buys first, then disable all new placements if deterioration continues.

Fallback behavior:
- Treat exchange-band fallback pricing as safety continuity mode, not primary profit mode.
- During prolonged fallback-only windows, reduce size and require stricter edge thresholds.

Tests:
- Add a test proving buys remain paused in `auto` mode when any profitability or quality gate fails.
- Add a test proving buys activate in `auto` mode only when all gates pass.
- Add a test proving automatic degradation back to paused/defensive mode on drift/adverse-fill threshold breach.
- Add a test proving inventory bands block risk-increasing placements at limits.
- Add a test proving circuit breakers disable new risk after configured loss/adverse streak conditions.

Acceptance criteria:
- Buy-side is never re-enabled solely by a boolean toggle; it requires measurable positive edge and healthy market conditions.
- Safety guards remain dominant over profit-seeking behavior at all times.
- Logs clearly show gate pass/fail reasons and mode transitions.
- Strategy can run in production with deterministic rollback to safe mode without manual intervention.

Observed production outcomes:
- Earlier production windows showed repeated sell placement rejects (`The price must be between <?>% and <?>% of the latest price`) during dislocated-book conditions.
- That sell-band rejection path has now been addressed and validated through the guarded fallback sell pricing flow documented in Section 14 and Section 17 updates.

### 15. Add extreme clamp-reprice guard to prevent unsafe quote jumps
Status: Completed on 2026-07-24 (code + tests), production validated on 2026-07-25

Objective:
- Prevent orders from being executed when latest-price clamping forces a very large jump from the intended passive quote.
- Avoid accidental execution at abnormal prices during extreme book dislocations.

Implementation notes:
- Added a clamp-reprice ratio guard in order placement for both buy and sell paths.
- If `executablePrice / requestedPrice` exceeds the configured safety ratio (or falls below its inverse), placement is skipped.
- The guard runs after latest-band clamping and before executable amount recalculation.
- New constant introduced in strategy: `MAX_CLAMP_REPRICE_RATIO` (currently `1.5`).

Tests:
- Added regression test proving BUY placement is skipped when clamp repricing is extreme.
- Added regression test proving SELL placement is skipped when clamp repricing is extreme.
- Re-ran focused strategy suite and full Jest suite after implementation.

Acceptance criteria:
- No order is sent when clamped executable price deviates excessively from the requested passive quote.
- Guard applies symmetrically to buy and sell placement paths.
- Existing reserve and executable-notional protections remain intact.

Validation outcomes:
- Focused strategy suite passed (`58/58`).
- Full Jest suite passed (`112/112`).
- Recent production cycles repeatedly logged extreme clamp fallback context (`...would clamp ... beyond the x1.50 safety ratio`) with no unsafe forced execution behavior observed.

### 16. Allow sell-side sparse-book recovery when reserve gating pauses buys
Status: Completed on 2026-07-24 (code + tests), production validated on 2026-07-25

Objective:
- Prevent a `0 buys / 0 sells` maintenance deadlock when reserve-constrained buy gating is active.
- Keep sell-side seeding operational so the book can recover instead of stalling.

Implementation notes:
- Production logs showed reserve-paused buys (`spendable USDT below minimum notional`) combined with sparse-cycle sell suppression.
- In that combination, depth/book sell paths were both skipped, leaving repeated `0/0` cycles.
- Added a focused condition to allow sparse sell recovery only when buys are intentionally paused by reserve gating.
- Existing sparse sell suppression remains unchanged for normal cycles where buys are placeable.

Tests:
- Extended the reserve-paused-cycle regression to assert buy placements remain paused.
- Added assertion that sell placement still proceeds in the same reserve-paused cycle.
- Re-ran focused strategy suite and full project suite after patching.

Acceptance criteria:
- When reserve gating pauses buys, sell placement paths remain eligible to seed/maintain book depth.
- The bot avoids repeated no-order sparse-cycle loops caused by mutually blocking buy/sell guards.
- Normal sparse-cycle sell suppression still protects against sell-heavy skew when buys are available.

Validation outcomes:
- Focused strategy suite passed (`58/58`).
- Full Jest suite passed (`112/112`).
- Changes committed and pushed in commit `417d435`.

Post-deploy checks:
- Confirm logs show buy pause warnings plus continuing sell seeding attempts rather than repeated `0 buys / 0 sells` stalling.
- Confirm sparse-cycle sell-suppression logs no longer block all sell placement during reserve-paused windows.

Post-deploy validation outcomes:
- Latest production windows repeatedly showed reserve/gate-driven buy suppression with continued sell-side maintenance (`0 buys / 2 sells`), not `0 / 0` deadlock behavior.

### 17. Add guarded fallback sell pricing for extreme clamp conditions
Status: Completed on 2026-07-24 (code + tests), production validated on 2026-07-25

Objective:
- Prevent repeated sell placement attempts in a cycle when passive sell quotes would be extreme-clamped.
- Keep sell-side activity alive by shifting to exchange-band-compatible fallback pricing instead of hard-pausing the cycle.

Implementation notes:
- Post-deploy logs on build `7fcb681` showed repeated sell placement attempts followed by repeated skips due to extreme clamp repricing.
- Replaced the hard pause with a guarded exchange-band fallback reference when the passive sell anchor would extreme-clamp.
- The fallback keeps sell-depth and seeded sell placement paths active while still respecting the latest-price band.
- Added explicit cycle-level log output explaining when fallback sell pricing is active.

Tests:
- Added regression test proving sell placement loops use fallback sell pricing when passive sell anchors would be extreme-clamped.
- Preserved existing reserve-paused buy gating coverage and extreme clamp per-order guard coverage.
- Re-ran focused strategy suite and full project suite after patching.

Acceptance criteria:
- No repeated per-attempt sell loop churn occurs in cycles where sell quotes would be extreme-clamped.
- One clear cycle-level warning explains why exchange-band fallback sell pricing is active.
- Sell placements can continue inside the allowed band instead of idling the book.
- Existing safety guards (reserve gating, drift guard, clamp-reprice guard) remain intact.

Validation outcomes:
- Focused strategy suite passed (`59/59`).
- Full Jest suite passed (`113/113`).
- Changes committed and pushed in commit `5fa631d`.

Post-deploy checks:
- Confirm logs emit the cycle-level exchange-band fallback warning for sell pricing.
- Confirm repeated same-cycle sell attempt/skip sequences are no longer present under the same abnormal-book conditions.
- Confirm sell placements resume inside the latest-price band instead of going fully idle on the sell side.

Post-deploy validation outcomes:
- Latest logs consistently emitted fallback-sell cycle warnings and continued sell-depth maintenance without returning to prior sell-reject churn patterns.

### 18. Restore controlled activity with a three-step recovery plan
Status: In progress (step 3 implemented in code; reserve tuning still pending)

Objective:
- Move from safe idle behavior back toward controlled placement activity without dropping the existing reserve, drift, and clamp protections.

Plan:
1. Keep the current safety-first idle baseline in place so the bot remains protected while the market is dislocated.
2. Lower `IDLE_BALANCE_RESERVE_USD` gradually; start around `175` on the current account so spendable USDT can exceed minimum notional for buy placements.
3. The guarded fallback quote mode for sell placements has now been implemented in code; verify it in production, then tune reserve conservatively if more activity is needed.

Expected outcome:
- The bot should progress from idle -> partial buy reactivation -> fuller two-sided book maintenance, while still respecting reserve, drift, and clamp safety logic.

Risks:
- Reducing reserve too quickly can re-enable unwanted exposure.
- Enabling fallback quoting without guardrails could reintroduce unsafe fills if extreme market dislocations persist.

### 19. Add adverse-fill buy-throttle guard to prevent one-sided inventory loss
Status: Completed on 2026-07-24 (code + tests + push)

Objective:
- Prevent further inventory accumulation when real external BUY fills consistently outpace SELL fills.
- Reduce loss risk from adverse flow by suppressing new BUY placements during imbalance stress windows.

Implementation notes:
- Added cumulative real-fill side counters in strategy accounting (`realBuyFills`, `realSellFills`).
- Added a cycle-level adverse-fill guard that activates when either:
	- Real BUY fills materially exceed real SELL fills (minimum count, gap, and ratio thresholds), or
	- Long inventory USD exceeds a depth-based guard threshold.
- When active, the guard suppresses BUY placement budget for that cycle and disables wash-trade placements to avoid adding synthetic buy pressure.
- Guard decisions emit explicit warning logs including BUY/SELL fill counts, gap, ratio, and inventory-vs-limit values.

Tests:
- Added regression test proving BUY placements are suppressed when adverse real-fill imbalance guard is active.
- Added regression test proving BUY placements resume once imbalance normalizes.
- Re-ran focused strategy suite after patching.

Acceptance criteria:
- During adverse BUY-side flow, the bot stops adding new BUY exposure automatically.
- Once flow/inventory pressure normalizes, BUY placements can resume without manual code changes.
- Existing reserve, drift, clamp, and sparse-book protections remain intact.

Validation outcomes:
- Focused strategy suite passed (`61/61`).
- Changes committed and pushed in commit `b76c4aa`.

Post-deploy checks:
- Confirm runtime logs show `Adverse-fill buy guard active` when BUY/SELL fill imbalance widens.
- Confirm logs show `Wash trades paused while adverse-fill buy guard is active.` during guarded cycles.
- Confirm BUY placements reappear after fill-side balance recovers and/or long inventory falls below guard threshold.

Verification goals:
- Confirm buys resume only after reserve reduction leaves enough spendable USDT above minimum notional.
- Confirm the fallback quote mode still refuses unsafe placements and logs its decision clearly.
- Confirm the `175` reserve starting point produces buy placements without reintroducing reserve-drain behavior.
- Confirm the bot does not regress into repeated skip loops or reserve-drain behavior.

Operational checklist:
- Use `pm2 logs epwx-bot --lines 50` to confirm the baseline is still safe-idle before changing reserve.
- Set `IDLE_BALANCE_RESERVE_USD=175` first, then lower only in small steps if buys still do not resume.
- After each reserve change, run `npx tsc -p tsconfig.json --noEmit` for a safe compile check, then `pm2 restart epwx-bot`, and verify `Calculated balance-aware order sizes...` plus at least one buy placement log.
- Stop lowering reserve once buy placements resume and the logs remain stable.

### 20. Add adverse-fill protection and preserve sell budget during reserve-pause cycles
Status: Completed on 2026-07-24

Objective:
- Track real BUY and SELL fills separately and suppress fresh BUY pressure when external flow is driving one-sided accumulation.
- Keep corrective BUYs available when inventory is short.
- Avoid starving SELL placements when BUY placement is paused by reserve limits.

Implementation notes:
- Added real BUY/SELL fill counters and an adverse-fill guard that uses fill skew plus inventory USD depth to decide when BUY placements should pause.
- Scoped the guard so short inventory can still trigger corrective BUY placement even if BUY fill counts are skewed.
- Restored SELL placement budget when BUY placements are reserve-constrained, so the strategy keeps seeding the ask side instead of stalling both sides.

Tests:
- Add a test proving BUY placements are suppressed when adverse real-fill imbalance is active.
- Add a test proving BUY placements resume after the imbalance normalizes.
- Add a test proving corrective BUYs are still allowed when inventory is short.
- Add a test proving SELL placements remain available when BUYs are paused by reserve.

Acceptance criteria:
- One-sided external taker flow no longer accelerates long inventory through repeated BUY placements.
- The strategy still supports inventory correction when it is directionally needed.
- Reserve-paused BUY cycles do not block SELL maintenance.

Implementation notes:
- Added a production guard for adverse BUY fill imbalance and a matching short-inventory exception.
- Kept wash-trade suppression aligned with the same adverse-fill condition.
- Added the sell-budget restoration fix so sell-side maintenance continues during reserve-constrained BUY cycles.
- Changes committed and pushed in commit `780472b`.

Post-deploy checks:
- Current runtime logs still show reserve-constrained BUY pauses, but SELL maintenance continues through the exchange-band fallback path.
- The previously observed 0-buy/1-sell deadlock no longer appears in the latest production chunks.
- DEX/CEX drift remains elevated, so wash trades stay paused and live quoting stays restricted to CEX-based prices.

### 21. Add FORCE_BUY_PAUSE policy switch for hard buy-side risk control
Status: Completed on 2026-07-24 (code + tests), production validated on 2026-07-25

Objective:
- Provide a deterministic policy switch to disable all BUY placements regardless of temporary spendable balance changes.
- Keep SELL-side maintenance active so the book does not fully idle when buy-side risk is intentionally disabled.

Implementation notes:
- Added new config flag `FORCE_BUY_PAUSE` (default `false`) in runtime configuration.
- Added cycle-level policy gating in strategy placement logic to suppress buy placement budget when the flag is enabled.
- Added direct hard guard in buy placement path so BUY orders are never sent when the policy flag is enabled.
- Added rebalance BUY suppression for policy-enabled windows to avoid cancel/rebuy behavior against the operator's buy-disable intent.
- Preserved sell-side maintenance paths and sparse recovery behavior while buys are policy-paused.
- Added explicit policy logs so policy pause is distinguishable from reserve-constrained pause.

Tests:
- Added regression test proving all buy placements are suppressed by policy while sell maintenance remains active.
- Added regression test proving direct `placeBuyOrder` is blocked when `FORCE_BUY_PAUSE=true`.
- Re-ran focused strategy suite after patching.

Acceptance criteria:
- No BUY orders are placed while `FORCE_BUY_PAUSE=true`, including direct placement and rebalance BUY paths.
- SELL-side maintenance remains active under existing spread/drift/clamp guards.
- Behavior is explicitly visible in logs and reversible by configuration.

Validation outcomes:
- Focused strategy suite passed (`65/65`).
- Phase-1 production run validated hard buy-side pause behavior with sells still maintained.
- Phase-2 run (`FORCE_BUY_PAUSE=false`) confirmed policy removal while buy-side remained gated by reactivation checks, proving clean policy toggle behavior.

### 22. Decouple destructive order-cancel operations from normal build/test commands
Status: Completed on 2026-07-25

Objective:
- Prevent unintended live order cancellations when running routine build and validation commands on a production server with real API credentials.

Implementation notes:
- Current `package.json` prebuild executes `src/scripts/cancel-all-orders.ts`, which is destructive when exchange keys are present.
- Routine checks should remain non-destructive (`jest`, `npx tsc -p tsconfig.json --noEmit`, and read-only connection tests).
- Move destructive actions behind explicit operator-only commands (for example: `cancel:orders`) and keep build/test paths safe by default.

Tests and verification:
- Verify `npm run build` no longer performs order cancellation by default.
- Verify explicit cancel command still works when intentionally invoked.
- Verify deployment docs distinguish safe validation commands from destructive maintenance commands.

Acceptance criteria:
- Routine CI/local/prod validation commands do not cancel live orders.
- Destructive order cancellation remains available but requires explicit operator intent.
- Deployment instructions clearly label command risk level.

Implementation notes:
- Removed automatic destructive hook from `npm run build` by deleting `prebuild` order-cancel execution in `package.json`.
- Added explicit destructive command `npm run cancel:orders`.
- Added confirmation guard to `src/scripts/cancel-all-orders.ts` requiring `CONFIRM_CANCEL_ALL_ORDERS=true`; otherwise the script exits without cancelling.
- Updated deployment flows (`deploy.sh`, `update-bot.sh`) to call cancel explicitly before restart.
- Updated docs (`README.md`, `DEPLOYMENT_GUIDE.md`) to separate safe commands from destructive commands.

Validation outcomes:
- `npm run build` now compiles only and is non-destructive.
- Order cancellation still works when intentionally invoked with confirmation: `CONFIRM_CANCEL_ALL_ORDERS=true npm run cancel:orders`.
- Added runtime cancellation controls for lifecycle events: `CANCEL_ORDERS_ON_START` and `CANCEL_ORDERS_ON_STOP` (both default to legacy `CANCEL_ORDERS_ON_DEPLOY` behavior when unset).
- Production validation confirmed that with `CANCEL_ORDERS_ON_DEPLOY=false`, `CANCEL_ORDERS_ON_START=false`, and `CANCEL_ORDERS_ON_STOP=false`, manual resting orders persist across restart cycles.
- Runtime evidence now includes explicit startup log `Skipping startup order cancellation (CANCEL_ORDERS_ON_START=false).`; shutdown path is similarly gated by `CANCEL_ORDERS_ON_STOP=false`.

### 23. Normalize `.env.example` as the production-aligned source template
Status: Completed on 2026-07-25

Objective:
- Keep deployment configuration consistent by using a single organized template file that mirrors current production-safe settings.
- Reduce rollout mistakes from duplicated/overlapping keys and scattered version blocks.

Implementation notes:
- Synced `.env.example` to the masked production baseline provided by operator.
- Reorganized the file into grouped sections (Core API/Chain, Trading Pair, Strategy Baseline, Balance/Depth, Drift/Wash, Inventory Bands, Rebalance Safety, Risk Limits, Logging).
- Consolidated duplicate keys to one effective entry per property.
- Added newly supported buy-reactivation keys (`BUY_REACTIVATION_MODE`, `MIN_NET_EDGE_BPS`, `MAX_EXEC_SPREAD_PERCENT`) under a dedicated heading.

Operational workflow (agreed):
- Treat `.env.example` as the git-tracked source template.
- For each release, update `.env.example` first, then copy only changed non-secret keys into production `.env` before deploy.
- Keep secrets masked in git and maintain real credentials only on server-side `.env`.

Acceptance criteria:
- `.env.example` remains readable, grouped, and duplicate-free.
- New config keys are added to the template in the same release they are introduced in code.
- Production `.env` updates can be applied from a clear diff against `.env.example`.

### 24. Remove API-key exposure from runtime request-parameter logs
Status: Completed on 2026-07-25

Objective:
- Prevent sensitive credentials from appearing in PM2/runtime logs during private API calls.

Implementation notes:
- Added private-param redaction in exchange-service logging for request payloads.
- `api_key` and `sign` are now masked as `***` in logged parameter objects.
- Updated `getBalances` and `getOpenOrders` parameter logs to use redacted payloads.
- Commit pushed: `795aec0`.

Validation outcomes:
- TypeScript compile check passed after patch (`npx tsc -p tsconfig.json --noEmit`).
- Runtime no longer prints raw API keys in those request-parameter log lines.
- Post-rotation and restart logs now consistently show masked values in open-orders params (`"api_key":"***"`, `"sign":"***"`).

Operational follow-up:
- Rotate the previously exposed Biconomy API key/secret because historical logs contained plaintext credentials.

### 25. Add idle-only auto wash mode with immediate real-fill cutover
Status: Pending

Objective:
- Allow very limited wash activity only after prolonged real-user inactivity.
- Immediately disable wash activity when any real external fill is detected.
- Keep real-user flow handling dominant over wash behavior at all times.

Behavior contract:
- Wash mode is enabled only in auto mode after a configurable idle window with no real fills.
- On first detected real fill, wash mode is disabled in the same cycle.
- Any open wash orders are cancelled immediately after real-fill detection.
- A cooldown window starts after real fills; wash mode cannot re-enable until cooldown expires.

Expected handling for user interaction with resting wash order:
- If a real user sells into a resting wash-side order, it is treated as a normal real fill.
- Inventory and PnL accounting update through existing real-fill paths.
- Wash mode is turned off immediately and remaining wash orders are cleared.
- Subsequent cycles run with wash disabled until cooldown and market-quality gates both pass.

Safety guardrails:
- Do not enable idle wash when drift or executable spread gates are failing.
- Keep idle-wash notional and pairs-per-cycle lower than normal wash configuration.
- Keep adverse-fill and inventory safety guards authoritative over idle-wash activation.
- Emit explicit mode-transition logs for enable, disable, and cooldown states.

Tests:
- Add a test proving auto wash enables only after the configured idle period.
- Add a test proving a real fill disables wash immediately and cancels pending wash orders.
- Add a test proving cooldown blocks wash re-enable even if idle timer passes.
- Add a test proving drift or spread failure keeps auto wash disabled during idle windows.

Acceptance criteria:
- Idle periods can trigger tightly bounded wash activity without changing real-fill accounting.
- Any real-user fill immediately preempts wash behavior and returns strategy to real-flow-first mode.
- Logs and tests make mode transitions deterministic and auditable.
