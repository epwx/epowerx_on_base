# Legitimate Market-Making Switching Strategy

This runbook answers the original objective with compliant behavior:

- Legitimate market-making is always primary.
- No self-trade and no wash flow.
- Profile choice changes by market condition and PnL quality.

Profiles used:

- profiles/legit-market-making-real-user.env
- profiles/legit-market-making-dislocated.env

## Objective

1. Generate real-user spread capture.
2. Protect inventory and avoid toxic fills.
3. Stay active in stress only when net edge remains acceptable.

## Condition Matrix

Use this matrix to choose profile.

1. Normal conditions
- Conditions:
  - executable spread less than or equal to 120%
  - DEX CEX drift less than or equal to 12%
  - adverse fill ratio stable
- Profile:
  - profiles/legit-market-making-real-user.env

2. Dislocated but tradable conditions
- Conditions:
  - executable spread above 120% and less than or equal to 600%
  - DEX CEX drift less than or equal to 45%
  - estimated net edge remains positive and realized PnL per real fill is non-negative over recent window
- Profile:
  - profiles/legit-market-making-dislocated.env

3. Capital or quality protection mode
- Conditions:
  - spendable USDT below minimum notional for repeated cycles
  - adverse fill ratio worsens above threshold
  - realized PnL per real fill turns negative over sustained window
- Action:
  - keep profile on real-user mode and increase reserve or reduce quote depth
  - if needed temporarily reduce TARGET_ORDERS_PER_SIDE to 1

## Profit Strategy With Real User Trades

1. Edge discipline first
- Keep minimum net edge positive.
- Raise MIN_NET_EDGE_BPS by 2 to 4 if PnL per fill weakens.

2. Inventory neutrality
- Keep skew limits tight so inventory does not become directional.
- If base inventory drifts, reduce buy depth or increase sell inner offset until balanced.

3. Throughput control
- If fills are too low and PnL quality is good, increase TARGET_ORDERS_PER_SIDE by 1.
- If fills are toxic, reduce depth and widen inner offsets.

4. Repeated gate warning handling
- If spendable USDT is repeatedly gated, lower IDLE_BALANCE_RESERVE_USD in small steps such as 10 to 20.
- Re-check that reserve still protects operational safety.

## Deployment Checklist

1. Confirm active profile path before restart.
2. Restart bot and validate startup logs show:
- SELF_TRADE_MODE off
- no wash pair placement logs
- no synthetic wash reconciliation logs

3. First 60 minute checks:
- real fills increasing
- wash trades remain zero
- realized PnL non-negative
- inventory close to neutral

## Recommended Daily Review

1. Real fills count and average PnL per real fill.
2. Inventory skew excursions.
3. Spread and drift regime distribution.
4. Percent of cycles blocked by buy gating.
5. Whether profile switching improved net performance.
