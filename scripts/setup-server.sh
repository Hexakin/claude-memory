#!/usr/bin/env bash
set -euo pipefail

# Claude Memory Server - First-time server setup
# Run as root on a fresh Hetzner CCX13 (Ubuntu 22.04/24.04)
# Usage: curl -sL <raw-url> | bash
#   or:  bash scripts/setup-server.sh

echo "=== Claude Memory Server - Setup ==="

# 1. System updates and build dependencies
apt-get update && apt-get upgrade -y
apt-get install -y \
  build-essential \
  curl \
  git \
  sqlite3 \
  libsqlite3-dev \
  cmake \
  python3 \
  unzip \
  jq \
  htop \
  ufw

# 2. Create service user (non-root)
if ! id "claude-memory" &>/dev/null; then
  useradd -r -m -d /opt/claude-memory -s /bin/bash claude-memory
  echo "Created user: claude-memory"
fi

# 3. Install Node.js 22 via nvm (for the claude-memory user)
sudo -u claude-memory bash << 'NODESETUP'
  export HOME=/opt/claude-memory
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
  nvm alias default 22

  # Install pnpm
  npm install -g pnpm
NODESETUP

# 4. Create directory structure
mkdir -p /opt/claude-memory/{app,data,data/projects,models,logs,backups}
chown -R claude-memory:claude-memory /opt/claude-memory

# 5. Configure firewall (only SSH + the app port for localhost; Cloudflare Tunnel handles external)
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
# Don't expose 3577 externally — Cloudflare Tunnel handles HTTPS
ufw --force enable

# 6. Configure systemd service
cp /opt/claude-memory/app/deploy/claude-memory.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable claude-memory

# 7. Set up log rotation
cat > /etc/logrotate.d/claude-memory << 'LOGROTATE'
/opt/claude-memory/logs/*.log {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  create 0640 claude-memory claude-memory
  postrotate
    systemctl reload claude-memory > /dev/null 2>&1 || true
  endscript
}
LOGROTATE

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Clone the repo:    sudo -u claude-memory git clone <repo-url> /opt/claude-memory/app"
echo "  2. Download model:    sudo -u claude-memory bash /opt/claude-memory/app/scripts/download-model.sh"
echo "  3. Configure env:     cp /opt/claude-memory/app/.env.example /opt/claude-memory/.env && nano /opt/claude-memory/.env"
echo "  4. First deploy:      bash /opt/claude-memory/app/scripts/deploy.sh"
echo "  5. Setup tunnel:      bash /opt/claude-memory/app/scripts/setup-cloudflare-tunnel.sh"
