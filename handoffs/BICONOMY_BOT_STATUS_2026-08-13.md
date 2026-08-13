# Biconomy Bot Status - 2026-08-13

## Summary

The epwx-bot is currently online and running under PM2.

Verified live state:
- PM2 status: online
- App name: epwx-bot
- Script path: /mnt/volume1_nyc3_1778885684099/epowerx_on_base/dist/index.js
- Uptime: ~85s at the time of last check
- Restarts: 548

## Active runtime configuration

The active .env is currently in the real-user safe profile state with the following strategy settings:

- EXCHANGE_NAME=biconomy
- SELF_TRADE_ENABLED=false
- SELF_TRADE_MODE=off
- BUY_REACTIVATION_MODE=auto
- MAX_DEX_CEX_DRIFT_PERCENT=75
- MAX_EXEC_SPREAD_PERCENT=600
- TARGET_ORDERS_PER_SIDE=3
- IDLE_WASH_ENABLE_AFTER_MS=31536000000

This matches the intended legitimate real-user profile behavior and disables self-trade / wash logic.

## Auto-switch behavior

The cron job is active and performing the spread-based auto-switch behavior via `scripts/switch-profile.sh --auto` every 2 minutes.

Observed recent behavior in the switch log:
- when recent spreads were low (~0.338%), it switched from dislocated to real-user
- when recent spreads were high (~68.118%), it switched from real-user to dislocated

This is working as designed via the hysteresis logic:
- enter dislocated when recent spread >= 18%
- exit dislocated when recent spread <= 6%
- confirm_cycles=3

## Recent bot behavior

The PM2 output log shows live order placement activity in the current cycle, not a startup crash loop:
- order book placement continues
- buy and sell orders are being placed with normal order placement logs
- self-trade is explicitly disabled: `SELF_TRADE_MODE=off`
- the bot is active and processing pricing / placement cycles

## Important note

Earlier startup failures were caused by missing runtime secret values. Those were corrected and the process was restarted successfully. The current state is healthy and online.

## Current recommendation

Keep the bot on the legitimate real-user profile unless spread conditions indicate a controlled transition to the dislocated profile via the auto-switch cron.

Do not commit live secret-bearing `.env` files to Git. Keep secrets in the secured base env and runtime config only.

## Last verified evidence

Fresh checks from the server showed:
- `pm2 describe epwx-bot` => status = online
- `.env` contains real-user profile values
- profile-switch cron log shows the expected real-user <-> dislocated transitions
- bot log continues to place orders without startup errors
