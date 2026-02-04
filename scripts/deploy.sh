#!/usr/bin/env bash
set -euo pipefail

# Deploy Claude Memory Server
# Run from server as root (or with sudo)

APP_DIR="/opt/claude-memory/app"
SERVICE_NAME="claude-memory"

echo "=== Deploying Claude Memory Server ==="

# 1. Pull latest code
echo "[1/5] Pulling latest code..."
sudo -u claude-memory bash -c "
  cd $APP_DIR
  git fetch origin
  git reset --hard origin/master
"

# 2. Install dependencies
echo "[2/5] Installing dependencies..."
sudo -u claude-memory bash -c "
  export HOME=/opt/claude-memory
  export NVM_DIR=\$HOME/.nvm
  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  cd $APP_DIR
  pnpm install --frozen-lockfile
"

# 3. Build
echo "[3/5] Building..."
sudo -u claude-memory bash -c "
  export HOME=/opt/claude-memory
  export NVM_DIR=\$HOME/.nvm
  [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
  cd $APP_DIR
  pnpm run build
"

# 4. Run migrations (implicit on server start, but validate build works)
echo "[4/5] Validating build..."
if [ ! -f "$APP_DIR/packages/server/dist/index.js" ]; then
  echo "ERROR: Build output not found at $APP_DIR/packages/server/dist/index.js"
  exit 1
fi

# 5. Restart service
echo "[5/5] Restarting service..."
systemctl restart "$SERVICE_NAME"

# Wait a moment and check status
sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo ""
  echo "=== Deploy successful ==="
  systemctl status "$SERVICE_NAME" --no-pager -l
  echo ""
  # Try health check
  PORT=$(grep -oP 'PORT=\K\d+' /opt/claude-memory/.env 2>/dev/null || echo "3577")
  HEALTH=$(curl -s "http://localhost:$PORT/health" 2>/dev/null || echo "unavailable")
  echo "Health: $HEALTH"
else
  echo ""
  echo "=== Deploy FAILED ==="
  systemctl status "$SERVICE_NAME" --no-pager -l
  echo ""
  echo "Logs:"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager
  exit 1
fi
