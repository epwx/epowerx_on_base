# EPWX Biconomy MM Bot - Deployment Guide
## DigitalOcean + PM2 Setup

This guide walks you through deploying your trading bot on DigitalOcean with PM2 process manager.

---

## 🚀 Quick Start (Using Automated Script)

### 1. Create DigitalOcean Droplet

1. Go to [DigitalOcean](https://cloud.digitalocean.com)
2. Click **Create** → **Droplets**
3. **Choose Configuration**:
   - **Image**: Ubuntu 22.04 LTS x64
   - **Plan**: Basic
   - **CPU Options**: Regular ($6/month) or Premium ($7/month)
   - **RAM**: 1GB minimum (2GB recommended for stability)
4. **Choose Region**: Closest to you or Singapore (for low latency to Biconomy)
5. **Authentication**: 
   - Choose **SSH Key** (recommended) or **Password**
   - If SSH: Click "New SSH Key" and paste your public key
6. **Hostname**: `epwx-bot` or any name you prefer
7. Click **Create Droplet**
8. Wait ~1 minute for droplet to be created
9. **Copy the IP address** (e.g., `164.92.123.456`)

### 2. Connect to Your Server

**Using SSH Key:**
```bash
ssh root@YOUR_DROPLET_IP
```

**Using Password:**
```bash
ssh root@YOUR_DROPLET_IP
# Enter password when prompted
```

### 3. Create Non-Root User (Recommended)

```bash
# Create user
adduser deployer
usermod -aG sudo deployer

# Copy SSH keys (if using SSH auth)
rsync --archive --chown=deployer:deployer ~/.ssh /home/deployer

# Switch to new user
su - deployer
```

### 4. Run Automated Deployment Script

```bash
# Download and run the deployment script
curl -o deploy.sh https://raw.githubusercontent.com/epwx/epowerx_on_base/main/deploy.sh
chmod +x deploy.sh
./deploy.sh
```

The script will:
- ✅ Update system packages
- ✅ Install Node.js 18.x
- ✅ Install PM2
- ✅ Clone your repository
- ✅ Install dependencies
- ✅ Configure environment variables (prompts you to edit)
- ✅ Build the project
- ✅ Test connection
- ✅ Start bot with PM2
- ✅ Configure auto-start on boot
- ✅ Setup firewall (optional)

**When prompted for .env configuration:**
1. Script will open nano editor
2. Replace `your-api-key-here` with your actual Biconomy API key
3. Replace `your-api-secret-here` with your actual Biconomy API secret
4. Save: `Ctrl + O`, then `Enter`
5. Exit: `Ctrl + X`

### 5. Whitelist Server IP on Biconomy

1. Log into [Biconomy Exchange](https://www.biconomy.com)
2. Go to **API Management**
3. Find your API key
4. Add your server IP: `YOUR_DROPLET_IP`
5. Save changes

### 6. Verify Bot is Running

```bash
pm2 status
pm2 logs epwx-bot
```

---

## 📋 Manual Step-by-Step Deployment

If you prefer to do it manually without the script:

### Step 1: Update System
```bash
sudo apt update
sudo apt upgrade -y
```

### Step 2: Install Node.js 18.x
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # Should show v18.x.x
npm --version
```

### Step 3: Install PM2
```bash
sudo npm install -g pm2
pm2 --version
```

### Step 4: Install Git
```bash
sudo apt install -y git
git --version
```

### Step 5: Clone Repository
```bash
cd ~
git clone https://github.com/epwx/epowerx_on_base.git
cd epowerx_on_base
```

**If repository is private:**
```bash
# Option A: Use GitHub Personal Access Token
git clone https://YOUR_TOKEN@github.com/epwx/epowerx_on_base.git

# Option B: Use SSH (after adding SSH key to GitHub)
git clone git@github.com:epwx/epowerx_on_base.git
```

### Step 6: Configure Environment
```bash
cp .env.example .env
nano .env
```

Update these values:
```env
BICONOMY_EXCHANGE_API_KEY=your-new-api-key
BICONOMY_EXCHANGE_API_SECRET=your-new-api-secret
```

Save: `Ctrl + O`, `Enter`, `Ctrl + X`

### Step 7: Install Dependencies
```bash
npm install
```

### Step 8: Build Project
```bash
npm run build
```

### Step 9: Test Connection
```bash
npm run test:connection
```

Expected output:
```
✅ ALL TESTS PASSED
Biconomy Exchange connection is working!
```

### Step 10: Start with PM2
```bash
pm2 start dist/index.js --name epwx-bot
pm2 save
```

### Step 11: Configure Auto-Start
```bash
pm2 startup
# Copy and run the command it outputs (starts with 'sudo env PATH=...')
pm2 save
```

### Step 12: Setup Firewall (Optional)
```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw enable
sudo ufw status
```

---

## 🛠️ Managing Your Bot

### View Logs
```bash
# Real-time logs
pm2 logs epwx-bot

# Last 100 lines
pm2 logs epwx-bot --lines 100

# Only errors
pm2 logs epwx-bot --err
```

### Check Status
```bash
pm2 status
pm2 info epwx-bot
```

### Monitor Resources
```bash
pm2 monit
```

### Restart Bot
```bash
pm2 restart epwx-bot
```

### Stop Bot
```bash
pm2 stop epwx-bot
```

### Start Bot
```bash
pm2 start epwx-bot
```

### Delete from PM2
```bash
pm2 delete epwx-bot
```

---

## 🔄 Updating Your Bot

When you push new code to GitHub:

```bash
cd ~/epowerx_on_base
git pull origin main
npm install                # If dependencies changed
npm run build
pm2 restart epwx-bot
pm2 logs epwx-bot          # Verify it started correctly
```

**Create an update script for convenience:**
```bash
nano ~/update-bot.sh
```

Add this:
```bash
#!/bin/bash
cd ~/epowerx_on_base
echo "Pulling latest code..."
git pull origin main
echo "Installing dependencies..."
npm install
echo "Building project..."
npm run build
echo "Restarting bot..."
pm2 restart epwx-bot
echo "✓ Update complete!"
pm2 logs epwx-bot --lines 20
```

Make it executable:
```bash
chmod +x ~/update-bot.sh
```

Now update with:
```bash
~/update-bot.sh
```

---

## 📊 Monitoring & Alerts

### PM2 Plus (Optional - $15/month)
Advanced monitoring with web dashboard:

```bash
pm2 plus
# Follow the prompts to create account
```

Features:
- Web dashboard
- Real-time metrics
- Custom alerts
- Error tracking
- Performance monitoring

### Free Alternatives

**1. Uptime Robot**
- Go to [UptimeRobot.com](https://uptimerobot.com)
- Create monitor for your droplet IP
- Get email alerts if server goes down

**2. Simple Log Monitoring Script**
Create `~/check-bot.sh`:
```bash
#!/bin/bash
if ! pm2 describe epwx-bot > /dev/null 2>&1; then
    echo "Bot is not running! Restarting..."
    cd ~/epowerx_on_base
    pm2 start dist/index.js --name epwx-bot
fi
```

Add to crontab (runs every 5 minutes):
```bash
crontab -e
# Add this line:
*/5 * * * * ~/check-bot.sh
```

---

## 🔒 Security Best Practices

### 1. Use SSH Keys (Not Passwords)
```bash
# On your local machine
ssh-keygen -t ed25519 -C "your_email@example.com"

# Copy to server
ssh-copy-id deployer@YOUR_DROPLET_IP

# Disable password authentication on server
sudo nano /etc/ssh/sshd_config
# Set: PasswordAuthentication no
sudo systemctl restart ssh
```

### 2. Keep System Updated
```bash
sudo apt update && sudo apt upgrade -y
```

Schedule automatic updates:
```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### 3. Use Fail2Ban (Prevent Brute Force)
```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 4. Regular Backups
Backup your .env file:
```bash
# Backup to encrypted location
gpg -c ~/epowerx_on_base/.env
# Save the .env.gpg file somewhere safe (not on the server)
```

---

## 🐛 Troubleshooting

### Bot Not Starting
```bash
# Check logs
pm2 logs epwx-bot --err

# Common issues:
# 1. Missing environment variables
cat .env

# 2. IP not whitelisted on Biconomy
# Solution: Add server IP on Biconomy dashboard

# 3. Port in use
sudo netstat -tulpn | grep node
```

### Connection Test Fails
```bash
cd ~/epowerx_on_base
npm run test:connection

# If fails, check:
# 1. API credentials are correct
# 2. Server IP is whitelisted
# 3. Network connectivity
ping www.biconomy.com
```

### PM2 Not Starting on Boot
```bash
# Re-run startup command
pm2 startup
# Copy and run the sudo command it outputs
pm2 save
```

### High Memory Usage
```bash
# Check memory
free -h

# Restart PM2
pm2 restart epwx-bot

# If persistent, upgrade droplet to 2GB RAM
```

### Bot Stops Randomly
```bash
# Check system logs
sudo journalctl -xe

# Check PM2 logs
pm2 logs epwx-bot --err --lines 200

# Enable auto-restart on crash (should be default)
pm2 start dist/index.js --name epwx-bot --restart-delay=5000
pm2 save
```

---

## 💰 Cost Breakdown

**Minimal Setup:**
- DigitalOcean Droplet 1GB: **$6/month**
- **Total: $6/month**

**Recommended Setup:**
- DigitalOcean Droplet 2GB: **$12/month**
- PM2 Plus monitoring: **$15/month** (optional)
- **Total: $12-27/month**

---

## 📞 Support

If you encounter issues:

1. Check logs: `pm2 logs epwx-bot --err`
2. Test connection: `npm run test:connection`
3. Review this guide's troubleshooting section
4. Check GitHub issues
5. Review API documentation at Biconomy

---

## ✅ Deployment Checklist

- [ ] DigitalOcean droplet created (Ubuntu 22.04)
- [ ] Connected via SSH
- [ ] Created non-root user (deployer)
- [ ] Ran deployment script OR completed manual steps
- [ ] Updated .env with real API credentials
- [ ] Server IP whitelisted on Biconomy Exchange
- [ ] Connection test passed
- [ ] Bot running in PM2
- [ ] PM2 auto-start configured
- [ ] Firewall configured (optional)
- [ ] Monitoring setup (optional)
- [ ] Backup .env file created
- [ ] Documented server IP and credentials (securely)

---

**Your bot should now be running 24/7 generating volume on Biconomy Exchange! 🎉**
