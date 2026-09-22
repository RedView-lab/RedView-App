#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# RedView — reconstruction complète de la base POI.
#
# Remplace `ingest-all-france.sh`, qui :
#   - téléchargeait 14 extraits régionaux Geofabrik (Rhône-Alpes, Île-de-France,
#     Nord-Pas-de-Calais, Champagne-Ardenne, Limousin, Poitou-Charentes et les
#     deux Normandie n'étaient PAS dans la liste),
#   - appelait `parse-pbf.js` qui jetait tous les objets non-node,
#   - masquait les échecs de téléchargement (`curl -s` sans `-f`) : la
#     Normandie a ainsi été « ingérée » avec 0 POI sans la moindre erreur,
#   - imprimait « TOUTES LES RÉGIONS DE FRANCE SONT INDEXÉES » quoi qu'il arrive.
#
# Ici : un seul extrait pays complet (pas de découpe aux frontières
# régionales, qui casse les ways à cheval sur deux régions), un importeur
# nodes + ways, et un contrôle de taille de fichier après téléchargement.
#
# Usage :
#   ./rebuild-poi-db.sh                        # France seule (défaut)
#   ./rebuild-poi-db.sh --with-neighbours      # France + pays frontaliers
#   ./rebuild-poi-db.sh --relations            # + multipolygones (Overpass)
#   ./rebuild-poi-db.sh --regions europe/france,europe/belgium
#   ./rebuild-poi-db.sh --swap                 # bascule le service en fin de course
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

GEOFABRIK="https://download.geofabrik.de"
OUT="data/pois.new.db"
WORK="/tmp/poi-pbf"
WITH_RELATIONS=0
DO_SWAP=0
REGIONS=()

# Pays frontaliers : un cycliste traverse les frontières, la base doit suivre.
NEIGHBOURS=(
  "europe/belgium"
  "europe/luxembourg"
  "europe/germany"
  "europe/switzerland"
  "europe/italy"
  "europe/spain"
  "europe/andorra"
  "europe/monaco"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --regions) REGIONS+=("$(echo "$2" | tr ',' ' ')"); shift 2 ;;
    --with-neighbours) REGIONS=("europe/france" "${NEIGHBOURS[@]}"); shift ;;
    --relations) WITH_RELATIONS=1; shift ;;
    --swap) DO_SWAP=1; shift ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "Option inconnue: $1"; exit 1 ;;
  esac
done

if [[ ${#REGIONS[@]} -eq 0 ]]; then
  REGIONS=("europe/france")
fi

mkdir -p "$WORK"
rm -f "$OUT" "$OUT-wal" "$OUT-shm"

echo "═══════════════════════════════════════════════════════"
echo " Reconstruction de la base POI — ${#REGIONS[@]} région(s)"
echo " Sortie : $OUT"
echo "═══════════════════════════════════════════════════════"

FIRST=1
for region in "${REGIONS[@]}"; do
  slug="$(basename "$region")"
  pbf="$WORK/$slug.osm.pbf"

  echo ""
  echo "── [$slug] téléchargement…"
  curl -fL --retry 3 --retry-delay 5 -o "$pbf" "$GEOFABRIK/$region-latest.osm.pbf"

  # Garde-fou : un extrait valide pèse au minimum quelques centaines de Ko.
  # Sans ce test, un 404 HTML était passé à l'importeur (cause du « 0 POI »
  # silencieux de l'ancien script).
  size=$(stat -c%s "$pbf")
  if [[ "$size" -lt 100000 ]]; then
    echo "❌ [$slug] fichier suspect ($size octets) — téléchargement invalide. Abandon."
    exit 1
  fi
  if ! head -c 2 "$pbf" | grep -q $'\x1a'; then
    echo "❌ [$slug] ce n'est pas un PBF (en-tête inattendu). Abandon."
    exit 1
  fi
  echo "   $(numfmt --to=iec "$size") — import…"

  if [[ $FIRST -eq 1 ]]; then
    nice -n 10 node --max-old-space-size=3072 import-osm.mjs --pbf "$pbf" --out "$OUT"
    FIRST=0
  else
    nice -n 10 node --max-old-space-size=3072 import-osm.mjs --pbf "$pbf" --out "$OUT" --append
  fi

  rm -f "$pbf"
done

if [[ $WITH_RELATIONS -eq 1 ]]; then
  echo ""
  echo "── Multipolygones (relations) via Overpass…"
  nice -n 10 node import-relations.mjs --db "$OUT" || \
    echo "⚠️  Étape relations échouée — la base reste valide sans elle."
fi

echo ""
echo "✅ Base construite : $OUT"
node -e "
const D=require('better-sqlite3');
const db=new D('$OUT',{readonly:true});
const t=db.prepare('SELECT count(*) n FROM pois').get().n;
const byType=db.prepare('SELECT osm_type, count(*) n FROM pois GROUP BY osm_type ORDER BY n DESC').all();
console.log('Total POI :', t.toLocaleString('fr-FR'));
for (const r of byType) console.log('   ', String(r.n).padStart(9), r.osm_type ?? '(non typé)');
"

if [[ $DO_SWAP -eq 1 ]]; then
  echo ""
  ./swap-db.sh "$OUT"
else
  echo ""
  echo "➡️  Pour basculer le service : ./swap-db.sh $OUT"
fi
