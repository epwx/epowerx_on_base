# Legitimate Market-Making Strategy (Real User Flow)

This strategy is designed for compliant, legitimate market-making and real-user flow capture.

## Important Scope

This plan excludes wash-style behavior:

- No self-trade orchestration.
- No synthetic wash pair generation.
- No same-price wash uptrend execution.

Use profile:

- `profiles/legit-market-making-real-user.env`

## Primary Goals

1. Earn spread from real user interaction.
2. Keep inventory near-neutral over time.
3. Avoid adverse fills during dislocated books.
4. Maintain continuous but risk-aware quoting.

## How This Profile Generates Profit

1. Passive two-sided quoting:
   - Two quotes per side and controlled depth (`TARGET_ORDERS_PER_SIDE=2`, depth targets 40/40) increase chance of interaction with natural flow.
2. Minimum edge gate:
   - `MIN_NET_EDGE_BPS=10` blocks placements that do not clear a minimum expected edge.
3. Adverse-fill protection:
   - `ADVERSE_FILL_RATIO_MAX=1.35` reduces exposure when fill quality deteriorates.
4. Inventory skew controls:
   - Skew parameters bias quoting to rebalance inventory before imbalance grows.
5. Spread and drift controls:
   - `MAX_EXEC_SPREAD_PERCENT=120` and `MAX_DEX_CEX_DRIFT_PERCENT=12` allow trading in imperfect conditions but avoid extreme dislocation.

## Operating Modes

## Mode A: Balanced (default in profile)

- Good for normal to moderately stressed books.
- Focus: stable participation and controlled risk.

## Mode B: Throughput Tilt (optional)

When volume is too low but quality remains acceptable:

- Lower `MIN_NET_EDGE_BPS` from 10 to 6.
- Increase `TARGET_ORDERS_PER_SIDE` from 2 to 3.
- Keep drift cap unchanged.

Expected result:

- Higher fill probability, lower per-fill edge.

## Mode C: Defensive Profit Protection (optional)

When adverse fills increase or book becomes toxic:

- Raise `MIN_NET_EDGE_BPS` from 10 to 14.
- Tighten `MAX_EXEC_SPREAD_PERCENT` from 120 to 80.
- Lower `TARGET_BUY_DEPTH_USD` and `TARGET_SELL_DEPTH_USD` from 40 to 25.

Expected result:

- Lower activity, improved expected fill quality.

## Monitoring Checklist

Track these every 15 to 30 minutes:

1. Real fills count (should increase; wash trades should remain zero).
2. Realized PnL and average PnL per real fill.
3. Inventory drift and rebalancing frequency.
4. Buy/sell gate warnings and spendable balance warnings.
5. Reject/cancel rates and adverse-fill guard activations.

## Guardrails and Alerts

Set operational alerts for:

1. Real fills stagnant for more than 60 minutes.
2. Inventory skew repeatedly near max limit.
3. Spendable USDT repeatedly below minimum notional.
4. Spread fallback active for more than 80% of cycles.

## Practical Tuning Sequence

If profitability is low:

1. Confirm real fill flow exists first.
2. Improve edge quality (`MIN_NET_EDGE_BPS` +2) before increasing order count.
3. Increase quote count only if adverse-fill ratio remains healthy.
4. Scale depth targets gradually (10 USD step changes) and re-evaluate every 1 to 2 hours.

If participation is too low:

1. Reduce edge gate slightly (10 -> 8 -> 6).
2. Increase per-side order count (2 -> 3).
3. Keep adverse-fill guard and drift cap unchanged until stable.

## Deployment Notes

1. Apply this profile to production process environment.
2. Restart bot and verify startup logs reflect:
   - `SELF_TRADE_MODE=off`
   - no wash pair placement messages
   - no synthetic wash reconciliation messages
3. Validate first 30 to 60 minutes before any additional tuning.
