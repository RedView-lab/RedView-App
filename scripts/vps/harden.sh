#!/usr/bin/env bash
# =============================================================================
# Durcissement du VPS RedView (141.145.220.99) — à lancer depuis la racine du
# repo, sur le poste local :
#
#   bash scripts/vps/harden.sh
#
# Étapes (chacune sauvegardée, rollback automatique en cas d'échec) :
#   1. poi-server : nouveau code (bornes /bbox /corridor), Fastify 5, base en
#      lecture seule, écoute 127.0.0.1.
#   2. nginx : Coolify retiré du port 80 public ; /brouter, /poi/, /weather/
#      réservés aux sources locales/Docker ; server_tokens off.
#      Vérifie depuis le conteneur de l'app que POI_UPSTREAM / BROUTER_UPSTREAM
#      / WEATHER_UPSTREAM répondent encore, sinon restaure nginx.
#   3. Ingest météo : utilisateur dédié + sandbox systemd (plus de root).
#   4. Contrôles externes.
# =============================================================================
set -euo pipefail

KEY="${KEY:-$HOME/.ssh/oracle_brouter.key}"
HOST="${HOST:-opc@141.145.220.99}"
PUBLIC_IP="141.145.220.99"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST")
STAGE=/tmp/redview-harden

cd "$(dirname "$0")/../.."

echo "==> Envoi des fichiers sur le VPS ($STAGE)"
"${SSH[@]}" "rm -rf $STAGE && mkdir -p $STAGE"
scp -q -i "$KEY" \
  server/poi-server/server.js \
  server/poi-server/db.js \
  server/poi-server/viewport-sampler.js \
  server/poi-ingest/import-overture.mjs \
  server/weather-daemon/brouter.conf \
  server/weather-daemon/redview-internal-only.conf \
  server/weather-daemon/redview-weather.service \
  "$HOST:$STAGE/"

"${SSH[@]}" "sudo bash -s" <<'REMOTE'
set -euo pipefail
STAGE=/tmp/redview-harden
TS=$(date +%Y%m%d-%H%M%S)

# ─── 1. poi-server ───────────────────────────────────────────────────────────
echo "==> [1/3] poi-server"
POI=/opt/poi-server
BAK=$POI/.bak-$TS
sudo -u opc mkdir -p "$BAK"
cp -a $POI/server.js $POI/db.js $POI/package.json $POI/package-lock.json $POI/import-overture.mjs "$BAK"/
[ -f $POI/viewport-sampler.js ] && cp -a $POI/viewport-sampler.js "$BAK"/
tar czf "$BAK/node_modules.tgz" -C $POI node_modules
mkdir -p /etc/systemd/system/poi-server.service.d
[ -f /etc/systemd/system/poi-server.service.d/hardening.conf ] && cp -a /etc/systemd/system/poi-server.service.d/hardening.conf "$BAK"/

poi_rollback() {
  echo "!! poi-server KO — rollback"
  cp -a "$BAK"/server.js "$BAK"/db.js "$BAK"/package.json "$BAK"/package-lock.json $POI/
  [ -f "$BAK"/viewport-sampler.js ] && cp -a "$BAK"/viewport-sampler.js $POI/
  rm -rf $POI/node_modules && tar xzf "$BAK/node_modules.tgz" -C $POI
  rm -f /etc/systemd/system/poi-server.service.d/hardening.conf
  systemctl daemon-reload && systemctl restart poi-server
  exit 1
}

install -o opc -g opc -m 644 $STAGE/server.js $STAGE/db.js $STAGE/viewport-sampler.js $POI/
install -o opc -g opc -m 755 $STAGE/import-overture.mjs $POI/import-overture.mjs
# Mise à jour en place : conserve better-sqlite3 déjà compilé pour ce Node.
( cd $POI && sudo -u opc npm install --omit=dev --no-audit --no-fund fastify@^5.12.5 \
  && sudo -u opc npm uninstall --no-audit --no-fund @fastify/cors ) || poi_rollback

cat > /etc/systemd/system/poi-server.service.d/hardening.conf <<'EOF'
[Service]
Environment=POI_HOST=127.0.0.1
Environment=POI_DB_READONLY=1
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
EOF
systemctl daemon-reload
systemctl restart poi-server
# Le démarrage construit la pyramide d'échantillonnage (~8 s sur 1,3 M POI)
# avant d'écouter : on attend jusqu'à 90 s.
POI_UP=0
for _ in $(seq 1 45); do
  if curl -fsS -m 5 http://127.0.0.1:17778/health >/dev/null 2>&1; then POI_UP=1; break; fi
  sleep 2
done
[ "$POI_UP" = 1 ] || poi_rollback
N=$(curl -fsS -m 10 "http://127.0.0.1:17778/bbox?south=-90&west=-180&north=90&east=180&limit=-1" | grep -o '"id"' | wc -l)
[ "$N" -le 1 ] || poi_rollback
echo "    poi-server OK (limit=-1 -> $N résultat), backup: $BAK"

# ─── 2. nginx ────────────────────────────────────────────────────────────────
echo "==> [2/3] nginx"
NBAK=/etc/nginx.bak-$TS
cp -a /etc/nginx "$NBAK"
DEFAULT_CONF=$(grep -rlE "listen\s+80\s+default_server" /etc/nginx/conf.d/ | head -1)
[ -n "$DEFAULT_CONF" ] || { echo "!! serveur default_server introuvable dans conf.d"; exit 1; }
echo "    remplace $DEFAULT_CONF"

nginx_rollback() {
  echo "!! nginx KO — rollback depuis $NBAK"
  rm -rf /etc/nginx && cp -a "$NBAK" /etc/nginx
  nginx -t && systemctl reload nginx
  exit 1
}

install -m 644 $STAGE/redview-internal-only.conf /etc/nginx/redview-internal-only.conf
install -m 644 $STAGE/brouter.conf "$DEFAULT_CONF"
# server_tokens peut déjà être défini ailleurs : éviter le doublon.
if grep -rqE "^\s*server_tokens" /etc/nginx/nginx.conf /etc/nginx/conf.d/ --exclude="$(basename "$DEFAULT_CONF")"; then
  sed -i '/^server_tokens off;$/d' "$DEFAULT_CONF"
fi
command -v restorecon >/dev/null && restorecon -R /etc/nginx || true
nginx -t || nginx_rollback
systemctl reload nginx
sleep 2

# L'app (conteneur Coolify) doit toujours joindre ses upstreams.
APP=$(docker ps --format '{{.Names}}' | grep '^q7lznj8fhunybhvuvm3jcu0u' | head -1)
if [ -n "$APP" ]; then
  RESULT=$(docker exec "$APP" node -e '
    const t = [["POI", process.env.POI_UPSTREAM, "/health"], ["BROUTER", process.env.BROUTER_UPSTREAM, "/brouter?lonlats=5.72,45.18|5.75,45.2&profile=trekking&alternativeidx=0&format=geojson"], ["WEATHER", process.env.WEATHER_UPSTREAM, "/meta.json"]];
    (async () => { let ok = true; for (const [n, base, p] of t) { if (!base) { console.log(n, "non défini"); continue; }
      try { const r = await fetch(base.replace(/\/+$/, "") + p, { signal: AbortSignal.timeout(20000) }); console.log(n, r.status); if (r.status === 403) ok = false; }
      catch (e) { console.log(n, "ERR", e.message); } } process.exit(ok ? 0 : 3); })();' ) || { echo "$RESULT"; nginx_rollback; }
  echo "$RESULT" | sed 's/^/    app -> /'
else
  echo "    (conteneur app introuvable — contrôle app->upstreams sauté)"
fi
echo "    nginx OK, backup: $NBAK"

# ─── 3. ingest météo sans root ───────────────────────────────────────────────
echo "==> [3/3] redview-weather"
id -u redview-weather >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin redview-weather
# Les dépendances Python doivent être importables hors de root (pas de /root/.local).
if ! sudo -u redview-weather /usr/bin/python3 -c "import numpy, gribberish, PIL" 2>/dev/null; then
  echo "    !! numpy/gribberish/PIL non importables par redview-weather (installés pour root ?)."
  echo "    !! Unité météo laissée inchangée. Corriger avec : sudo /usr/bin/python3 -m pip install numpy gribberish pillow"
  rm -rf $STAGE
  exit 0
fi
chown -R redview-weather:redview-weather /var/www/weather
[ -f /etc/systemd/system/redview-weather.service ] && cp -a /etc/systemd/system/redview-weather.service /etc/systemd/system/redview-weather.service.bak-$TS
install -m 644 $STAGE/redview-weather.service /etc/systemd/system/redview-weather.service
systemctl daemon-reload
# Exécution de test en arrière-plan (l'ingest peut durer plusieurs minutes).
systemctl start --no-block redview-weather.service
echo "    unité installée — suivre : journalctl -u redview-weather -f"
echo "    rollback éventuel : cp /etc/systemd/system/redview-weather.service.bak-$TS /etc/systemd/system/redview-weather.service && systemctl daemon-reload"

rm -rf $STAGE
REMOTE

echo "==> [4/4] Contrôles externes"
for u in / /poi/health /brouter /weather/meta.json; do
  printf '    http://%s%-20s -> ' "$PUBLIC_IP" "$u"
  curl -s -o /dev/null -m 10 -w '%{http_code}\n' "http://$PUBLIC_IP$u" || echo "timeout"
done
printf '    app POI corridor -> '
curl -s -m 30 -X POST -H 'Content-Type: application/json' \
  -d '{"points":[[45.18,5.72],[45.2,5.75]],"radiusM":500,"categories":["toilets","water","food"]}' \
  'https://app.redview.tech/api/poi?op=corridor' | head -c 80; echo
echo
echo "Attendu : / -> 404, /poi/health /brouter /weather -> 403, corridor -> features non vide."
echo "Coolify : ssh -i $KEY -L 8000:127.0.0.1:8000 -L 6001:127.0.0.1:6001 -L 6002:127.0.0.1:6002 $HOST  puis http://localhost:8000"
