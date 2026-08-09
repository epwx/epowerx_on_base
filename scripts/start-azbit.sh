#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/mnt/volume1_nyc3_1778885684099/epowerx_on_base"
cd "$ROOT_DIR"

if [[ ! -f .env.azbit ]]; then
  echo ".env.azbit not found"
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.azbit
set +a

echo "AZBIT_CHECK EXCHANGE_NAME=${EXCHANGE_NAME:-} TRADING_PAIR=${TRADING_PAIR:-} RUNTIME_STATE_FILE=${RUNTIME_STATE_FILE:-} LOG_FILE_PREFIX=${LOG_FILE_PREFIX:-}"

pm2 delete epwx-azbit-bot >/dev/null 2>&1 || true
pm2 start dist/index.js --name epwx-azbit-bot --time --update-env
pm2 save
