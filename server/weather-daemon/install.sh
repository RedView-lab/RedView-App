#!/usr/bin/env bash
set -e

# ==============================================================================
# Script d'installation de la météo RedView pour le VPS Oracle Cloud (Ubuntu/Debian)
# ==============================================================================

echo "===================================================================="
echo "🌦️ Installing RedView Weather Daemon on Oracle VPS..."
echo "===================================================================="

# 1. Dossiers
echo "[1/5] Creating application directories..."
mkdir -p /opt/redview-weather
mkdir -p /var/www/weather/tiles
# Utilisateur système dédié : l'ingest ne tourne plus en root.
if ! id -u redview-weather >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin redview-weather
fi
chown -R redview-weather:redview-weather /var/www/weather
chmod -R 755 /var/www/weather

# 2. Environnement Python et dépendances
echo "[2/5] Setting up Python virtual environment..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv nginx libwebp-dev

if [ ! -d "/opt/redview-weather/venv" ]; then
    python3 -m venv /opt/redview-weather/venv
fi

/opt/redview-weather/venv/bin/pip install --upgrade pip -q
/opt/redview-weather/venv/bin/pip install pillow requests -q

# 3. Copie des fichiers
echo "[3/5] Copying daemon scripts..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/ingest.py" /opt/redview-weather/ingest.py
cp "$SCRIPT_DIR/ingest_europe.py" /opt/redview-weather/ingest_europe.py
cp "$SCRIPT_DIR/server.py" /opt/redview-weather/server.py
chown -R root:root /opt/redview-weather
chmod 755 /opt/redview-weather/ingest.py /opt/redview-weather/ingest_europe.py /opt/redview-weather/server.py

# 4. Mise en place du minuteur systemd
echo "[4/5] Configuring systemd timer..."
cp "$SCRIPT_DIR/redview-weather.service" /etc/systemd/system/
cp "$SCRIPT_DIR/redview-weather.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now redview-weather.timer

# Lance une première ingestion
echo "⏳ Running initial weather tile generation..."
sudo -u redview-weather /opt/redview-weather/venv/bin/python /opt/redview-weather/ingest.py --output-dir /var/www/weather --format webp

# 5. Configuration nginx
# Le serveur par défaut (port 80) est décrit par brouter.conf, qui inclut
# redview-internal-only.conf : /brouter, /poi/ et /weather/ ne sont servis
# qu'aux sources locales/Docker. On ne copie PAS nginx-weather.conf dans
# conf.d (bloc `location` invalide au niveau http).
echo "[5/5] Nginx : installer manuellement brouter.conf (conf.d) et redview-internal-only.conf (/etc/nginx/),"
echo "      puis : nginx -t && systemctl reload nginx"

echo "===================================================================="
echo "✨ RedView Weather Daemon successfully installed and active!"
echo "   Endpoint (interne) : http://127.0.0.1/weather/meta.json"
echo "===================================================================="
