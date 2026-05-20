#!/bin/bash

###############################################################################
# Quick Update Script for EPWX Bot
# Run this script whenever you push new code to update the live bot
###############################################################################

set -e

echo "🔄 Updating EPWX Biconomy MM Bot..."
echo ""

# Navigate to app directory
cd ~/epowerx_on_base

# Pull latest code
echo "📥 Pulling latest code from GitHub..."
git pull origin main
echo "🔖 Current commit: $(git rev-parse HEAD)"

# Install any new dependencies
echo "📦 Installing dependencies..."
npm install

# Build project
echo "🔨 Building TypeScript..."
npm run build

# Restart bot
echo "♻️  Restarting bot..."
pm2 restart epwx-bot
echo "📍 PM2 script path:"
pm2 describe epwx-bot | grep "script path"

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
