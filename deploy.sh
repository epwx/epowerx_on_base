#!/bin/bash

###############################################################################
# EPWX Biconomy MM Bot - DigitalOcean Deployment Script
# This script automates the deployment of the trading bot on a fresh Ubuntu server
###############################################################################

set -e  # Exit on any error

echo "=========================================="
echo "EPWX Biconomy MM Bot - Deployment Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}➜ $1${NC}"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    print_error "Please do not run this script as root. Run as a regular user with sudo privileges."
    exit 1
fi

echo "Step 1: System Update"
echo "----------------------------------------"
print_info "Updating system packages..."
sudo apt update && sudo apt upgrade -y
print_success "System updated"
echo ""

echo "Step 2: Install Node.js 18.x"
echo "----------------------------------------"
print_info "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
print_success "Node.js installed: $(node --version)"
print_success "NPM installed: $(npm --version)"
echo ""

echo "Step 3: Install PM2 Process Manager"
echo "----------------------------------------"
print_info "Installing PM2 globally..."
sudo npm install -g pm2
print_success "PM2 installed: $(pm2 --version)"
echo ""

echo "Step 4: Install Git"
echo "----------------------------------------"
if ! command -v git &> /dev/null; then
    print_info "Installing Git..."
    sudo apt install -y git
    print_success "Git installed: $(git --version)"
else
    print_success "Git already installed: $(git --version)"
fi
echo ""

echo "Step 5: Clone Repository"
echo "----------------------------------------"
print_warning "NOTE: You may need to set up SSH keys or use HTTPS with token"
read -p "Enter your GitHub repository URL (default: https://github.com/epwx/epowerx_on_base.git): " REPO_URL
REPO_URL=${REPO_URL:-https://github.com/epwx/epowerx_on_base.git}

APP_DIR="$HOME/epowerx_on_base"

if [ -d "$APP_DIR" ]; then
    print_warning "Directory $APP_DIR already exists. Pulling latest changes..."
    cd "$APP_DIR"
    git pull origin main
else
    print_info "Cloning repository..."
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi
print_success "Repository ready at $APP_DIR"
echo ""

echo "Step 6: Install Dependencies"
echo "----------------------------------------"
print_info "Installing Node.js dependencies..."
npm install
print_success "Dependencies installed"
echo ""

echo "Step 7: Configure Environment Variables"
echo "----------------------------------------"
if [ -f ".env" ]; then
    print_warning ".env file already exists"
    read -p "Do you want to edit it? (y/n): " EDIT_ENV
    if [ "$EDIT_ENV" = "y" ]; then
        nano .env
    fi
else
    print_info "Creating .env file from example..."
    cp .env.example .env
    print_warning "IMPORTANT: You must edit the .env file with your credentials"
    echo ""
    echo "Press Enter to open the .env file in nano editor..."
    read
    nano .env
fi
print_success "Environment configured"
echo ""

echo "Step 8: Build Project"
echo "----------------------------------------"
print_info "Building TypeScript project..."
npm run build
print_success "Project built successfully"
echo ""

echo "Step 9: Test Connection"
echo "----------------------------------------"
print_info "Testing Biconomy Exchange connection..."
if npm run test:connection; then
    print_success "Connection test passed!"
else
    print_error "Connection test failed. Please check your .env configuration."
    exit 1
fi
echo ""

echo "Step 10: Configure PM2"
echo "----------------------------------------"
print_info "Starting bot with PM2..."
pm2 start dist/index.js --name epwx-bot --time
pm2 save
print_success "Bot started with PM2"
echo ""

echo "Step 11: Setup PM2 Startup Script"
echo "----------------------------------------"
print_info "Configuring PM2 to start on system boot..."
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME
pm2 save
print_success "PM2 startup configured"
echo ""

echo "Step 12: Configure Firewall (Optional)"
echo "----------------------------------------"
read -p "Do you want to configure UFW firewall? (y/n): " SETUP_FIREWALL
if [ "$SETUP_FIREWALL" = "y" ]; then
    print_info "Setting up UFW firewall..."
    sudo apt install -y ufw
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow ssh
    sudo ufw --force enable
    print_success "Firewall configured (SSH allowed)"
else
    print_warning "Skipping firewall configuration"
fi
echo ""

echo "=========================================="
echo "🎉 DEPLOYMENT COMPLETE!"
echo "=========================================="
echo ""
print_success "Bot is now running!"
echo ""
echo "Useful Commands:"
echo "----------------------------------------"
echo "View logs:        pm2 logs epwx-bot"
echo "Monitor:          pm2 monit"
echo "Status:           pm2 status"
echo "Restart:          pm2 restart epwx-bot"
echo "Stop:             pm2 stop epwx-bot"
echo "View last 100:    pm2 logs epwx-bot --lines 100"
echo ""
echo "Update Bot:"
echo "----------------------------------------"
echo "cd $APP_DIR"
echo "git pull origin main"
echo "npm install"
echo "npm run build"
echo "pm2 restart epwx-bot"
echo ""
echo "Check bot status now:"
print_info "pm2 status"
pm2 status
echo ""
print_warning "IMPORTANT: Make sure your server IP is whitelisted on Biconomy Exchange!"
echo ""
