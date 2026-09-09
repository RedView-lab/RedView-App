#!/usr/bin/env bash
set -e

# ==============================================================================
# RedView Weather Installation Script for Oracle Cloud VPS (Ubuntu/Debian)
# ==============================================================================

echo "===================================================================="
echo "🌦️ Installing RedView Weather Daemon on Oracle VPS..."
echo "===================================================================="

# 1. Directories
echo "[1/5] Creating application directories..."
mkdir -p /opt/redview-weather
mkdir -p /var/www/weather/tiles
chmod -R 755 /var/www/weather

# 2. Python environment & dependencies
echo "[2/5] Setting up Python virtual environment..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nginx libwebp-dev

if [ ! -d "/opt/redview-weather/venv" ]; then
    python3 -m venv /opt/redview-weather/venv
fi

/opt/redview-weather/venv/bin/pip install --upgrade pip -q
/opt/redview-weather/venv/bin/pip install pillow requests -q

# 3. Copy files
echo "[3/5] Copying daemon scripts..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/ingest.py" /opt/redview-weather/ingest.py
cp "$SCRIPT_DIR/server.py" /opt/redview-weather/server.py
chmod +x /opt/redview-weather/ingest.py /opt/redview-weather/server.py

# 4. Systemd Timer Setup
echo "[4/5] Configuring systemd timer..."
cp "$SCRIPT_DIR/redview-weather.service" /etc/systemd/system/
cp "$SCRIPT_DIR/redview-weather.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now redview-weather.timer

# Run initial ingestion
echo "⏳ Running initial weather tile generation..."
/opt/redview-weather/venv/bin/python /opt/redview-weather/ingest.py --output-dir /var/www/weather --format webp

# 5. Nginx Configuration
echo "[5/5] Configuring Nginx..."
if [ -d "/etc/nginx/conf.d" ]; then
    cp "$SCRIPT_DIR/nginx-weather.conf" /etc/nginx/conf.d/redview-weather.conf
    nginx -t && systemctl reload nginx
    echo "✅ Nginx reloaded with /weather/ endpoint!"
else
    echo "⚠️ /etc/nginx/conf.d not found. Please manually include nginx-weather.conf in your nginx.conf."
fi

echo "===================================================================="
echo "✨ RedView Weather Daemon successfully installed and active!"
echo "   Endpoint: http://141.145.220.99/weather/meta.json"
echo "===================================================================="
