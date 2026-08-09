#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/mnt/volume1_nyc3_1778885684099/epowerx_on_base"
cd "$ROOT_DIR"

if [[ ! -f .env.azbit ]]; then
  echo ".env.azbit not found"
  exit 1
fi

echo "Starting Azbit with application-managed .env.azbit loading"

pm2 delete epwx-azbit-bot >/dev/null 2>&1 || true
env -i \
  HOME="$HOME" \
  USER="$USER" \
  PATH="$PATH" \
  NODE_ENV=production \
  ENV_FILE=.env.azbit \
  pm2 start dist/index.js --name epwx-azbit-bot --time
pm2 save
rm -f "$HOME/.pm2/dump.pm2.bak"
