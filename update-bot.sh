#!/bin/bash

###############################################################################
# Quick Update Script for EPWX Bot
# Run this script whenever you push new code to update the live bot
###############################################################################

set -euo pipefail

echo "🔄 Updating EPWX Biconomy MM Bot..."
echo ""

# Navigate to app directory
cd ~/epowerx_on_base

APP_ENTRY="$PWD/dist/index.js"
BUILD_MARKER="build-e38bfba-marker"
RUNTIME_GIT_SHA=""

# Pull latest code
echo "📥 Pulling latest code from GitHub..."
git pull --ff-only origin main
RUNTIME_GIT_SHA="$(git rev-parse --short HEAD)"
echo "🔖 Current commit: $RUNTIME_GIT_SHA"

# Install any new dependencies
echo "📦 Installing dependencies..."
npm install

# Remove stale build output before recompiling
echo "🧹 Cleaning dist/..."
rm -rf dist

# Build project
echo "🔨 Building TypeScript..."
npm run build

echo "🧪 Verifying compiled build marker..."
if ! grep -R "$BUILD_MARKER" dist >/dev/null 2>&1; then
	echo "❌ Expected build marker '$BUILD_MARKER' not found in dist/. Aborting restart."
	exit 1
fi
echo "✅ Build marker present in compiled output"

# Restart bot
echo "♻️  Recreating PM2 process..."
pm2 delete epwx-bot >/dev/null 2>&1 || true
RUNTIME_GIT_SHA="$RUNTIME_GIT_SHA" pm2 start "$APP_ENTRY" --name epwx-bot --time --update-env
pm2 save
echo "📍 PM2 runtime info:"
pm2 describe epwx-bot | grep -E "script path|exec cwd"

# Show status
echo ""
echo "✅ Update complete!"
echo ""
echo "Bot status:"
pm2 status epwx-bot

echo ""
echo "Recent logs:"
pm2 logs epwx-bot --lines 20 --nostream

echo ""
echo "To view live logs, run: pm2 logs epwx-bot"
