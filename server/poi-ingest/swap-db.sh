#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# RedView — bascule atomique de la base POI.
#
# Remplace le fichier de base du service par la base fraîchement construite,
# en gardant une sauvegarde horodatée de l'ancienne. Le service est arrêté
# le temps du `mv` (instantané, même système de fichiers) puis redémarré.
#
# Usage : ./swap-db.sh [data/pois.new.db]
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

NEW="${1:-data/pois.new.db}"
LIVE="data/pois.db"

if [[ ! -f "$NEW" ]]; then
  echo "❌ Base source introuvable : $NEW"
  exit 1
fi

echo "── Vérification de la base source…"
node -e "
const D=require('better-sqlite3');
const db=new D('$NEW',{readonly:true});
const n=db.prepare('SELECT count(*) n FROM pois').get().n;
const r=db.prepare('SELECT count(*) n FROM poi_rtree').get().n;
if (n === 0) { console.error('❌ Base vide, bascule annulée.'); process.exit(1); }
if (n !== r) { console.error('❌ Incohérence pois ('+n+') / poi_rtree ('+r+'), bascule annulée.'); process.exit(1); }
const integrity=db.pragma('integrity_check');
console.log('   POI:', n.toLocaleString('fr-FR'), '| rtree:', r.toLocaleString('fr-FR'), '| integrity:', integrity[0].integrity_check);
"

STAMP="$(date +%Y%m%d-%H%M%S)"
echo "── Arrêt du service…"
sudo systemctl stop poi-server

if [[ -f "$LIVE" ]]; then
  echo "── Sauvegarde de l'ancienne base → data/backup-pois-$STAMP.db"
  cp "$LIVE" "data/backup-pois-$STAMP.db"
fi

rm -f "$LIVE-wal" "$LIVE-shm"
mv "$NEW" "$LIVE"
rm -f "$NEW-wal" "$NEW-shm"

echo "── Redémarrage du service…"
sudo systemctl start poi-server
sleep 3

echo "── Vérification via HTTP…"
curl -fsS http://127.0.0.1:17778/health || { echo "❌ Le service ne répond pas."; exit 1; }
echo ""
echo "✅ Bascule terminée. Ancienne base conservée dans data/backup-pois-$STAMP.db"
echo "   (pense à purger les sauvegardes : ls -la data/backup-pois-*.db)"
