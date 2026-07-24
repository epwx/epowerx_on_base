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

Acceptance criteria:
- Cap warnings become occasional safety events rather than dominant sizing behavior.
- Book depth progresses toward configured targets with fewer under-sized placements.
- No regression in order-count/depth caps or drift-guard behavior.

Observed production outcomes:
- Runtime repeatedly capped into the `36B-40B` range as expected with improved per-order notional versus the prior `8B` cap setting.
- Order-count and depth controls remained bounded during the same windows (`4x4` target behavior and depth progression toward configured limits).

### 13. Add rebalance execution price guard for abnormal-book conditions
Status: Completed on 2026-07-24 (deployment validation pending)

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