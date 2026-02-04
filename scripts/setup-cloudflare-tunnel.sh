#!/usr/bin/env bash
set -euo pipefail

# Setup Cloudflare Tunnel for Claude Memory Server
# Requires: Cloudflare account with a domain, and a tunnel token from the dashboard
#
# Steps to get a tunnel token:
# 1. Go to https://one.dash.cloudflare.com
# 2. Zero Trust → Networks → Tunnels → Create a Tunnel
# 3. Name it "claude-memory"
# 4. Copy the tunnel token
# 5. Add a public hostname: claude-memory.yourdomain.com → http://localhost:3577

echo "=== Cloudflare Tunnel Setup ==="

# Install cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "Installing cloudflared..."
  curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  dpkg -i cloudflared.deb
  rm cloudflared.deb
  echo "cloudflared installed: $(cloudflared version)"
else
  echo "cloudflared already installed: $(cloudflared version)"
fi

# Read tunnel token from env or prompt
CF_TOKEN="${CF_TUNNEL_TOKEN:-}"
if [ -z "$CF_TOKEN" ]; then
  # Try reading from .env file
  if [ -f /opt/claude-memory/.env ]; then
    CF_TOKEN=$(grep -oP 'CF_TUNNEL_TOKEN=\K.+' /opt/claude-memory/.env 2>/dev/null || true)
  fi
fi

if [ -z "$CF_TOKEN" ]; then
  echo ""
  echo "No CF_TUNNEL_TOKEN found. Please:"
  echo "  1. Go to https://one.dash.cloudflare.com"
  echo "  2. Zero Trust → Networks → Tunnels → Create a Tunnel"
  echo "  3. Name it 'claude-memory', select Cloudflared"
  echo "  4. Copy the tunnel token"
  echo "  5. Add it to /opt/claude-memory/.env as CF_TUNNEL_TOKEN=<token>"
  echo "  6. Add a public hostname route: your-subdomain.yourdomain.com → http://localhost:3577"
  echo "  7. Re-run this script"
  exit 1
fi

# Install as systemd service
echo "Installing cloudflared as systemd service..."
cloudflared service install "$CF_TOKEN"

# Enable and start
systemctl enable cloudflared
systemctl start cloudflared

sleep 3
if systemctl is-active --quiet cloudflared; then
  echo ""
  echo "=== Cloudflare Tunnel active ==="
  echo "Your MCP server is now accessible via your configured hostname."
  echo ""
  echo "Claude Code config (~/.claude.json):"
  echo '  "mcpServers": {'
  echo '    "claude-memory": {'
  echo '      "type": "http",'
  echo '      "url": "https://YOUR-SUBDOMAIN.yourdomain.com/mcp",'
  echo '      "headers": {'
  echo '        "Authorization": "Bearer YOUR-AUTH-TOKEN"'
  echo '      }'
  echo '    }'
  echo '  }'
else
  echo "ERROR: cloudflared service failed to start"
  journalctl -u cloudflared -n 20 --no-pager
  exit 1
fi
