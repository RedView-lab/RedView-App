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
#
# Complétion par les sources externes (voir REDVIEW_POI_EXTERNAL_SOURCES.md) :
#   ./rebuild-poi-db.sh --with-external
#   ./rebuild-poi-db.sh --with-external --atp-zip /tmp/output.zip --skip-overture
#
# `--with-external` enchaîne, dans cet ordre : Overture → SIRENE → AllThePlaces.
# Overture d'abord car elle agrège déjà Meta, Microsoft, Foursquare et
# AllThePlaces : les sources suivantes ne sont dédupliquées que sur ce qui
# reste, ce qui évite d'importer trois fois le même contenu.
#
# Prérequis : binaire DuckDB dans le PATH ou via DUCKDB_BIN (Overture et
# SIRENE sont distribuées en Parquet).
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

GEOFABRIK="https://download.geofabrik.de"
OUT="data/pois.new.db"
WORK="/tmp/poi-pbf"
WITH_RELATIONS=0
DO_SWAP=0
WITH_EXTERNAL=0
SKIP_OVERTURE=0
SKIP_SIRENE=0
SKIP_ATP=0
OVERTURE_RELEASE=""
ATP_ZIP=""
SIRENE_GEOLOC=""
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
    --with-external) WITH_EXTERNAL=1; shift ;;
    --skip-overture) SKIP_OVERTURE=1; shift ;;
    --skip-sirene) SKIP_SIRENE=1; shift ;;
    --skip-atp) SKIP_ATP=1; shift ;;
    --overture-release) OVERTURE_RELEASE="$2"; shift 2 ;;
    --atp-zip) ATP_ZIP="$2"; shift 2 ;;
    --sirene-geoloc) SIRENE_GEOLOC="$2"; shift 2 ;;
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

# ── Sources externes ────────────────────────────────────────────────────
# Overture d'abord : elle agrège déjà Meta, Microsoft, Foursquare et
# AllThePlaces. Chaque source suivante n'est dédupliquée que sur ce qui reste.
if [[ $WITH_EXTERNAL -eq 1 ]]; then
  if ! command -v duckdb >/dev/null 2>&1 && [[ -z "${DUCKDB_BIN:-}" ]] && [[ ! -x "bin/duckdb" ]]; then
    echo ""
    echo "❌ --with-external requiert DuckDB : Overture et SIRENE sont en Parquet,"
    echo "   et c'est DuckDB qui les lit à distance sans les télécharger."
    echo "   Installation : curl -Ls https://install.duckdb.org | sh"
    exit 1
  fi

  if [[ $SKIP_OVERTURE -eq 0 ]]; then
    echo ""
    echo "── Overture Maps (thème places)…"
    OVER_ARGS=(--db "$OUT" --enrich)
    [[ -n "$OVERTURE_RELEASE" ]] && OVER_ARGS+=(--release "$OVERTURE_RELEASE")
    nice -n 10 node import-overture.mjs "${OVER_ARGS[@]}"
  fi

  if [[ $SKIP_SIRENE -eq 0 ]]; then
    echo ""
    echo "── SIRENE géocodée (INSEE)…"
    SIR_ARGS=(--db "$OUT")
    [[ -n "$SIRENE_GEOLOC" ]] && SIR_ARGS+=(--geoloc "$SIRENE_GEOLOC")
    nice -n 10 node import-sirene.mjs "${SIR_ARGS[@]}"
  fi

  if [[ $SKIP_ATP -eq 0 ]]; then
    if [[ -z "$ATP_ZIP" ]]; then
      echo ""
      echo "⚠️  AllThePlaces ignoré : aucune archive fournie."
      echo "   Dernier run : https://data.alltheplaces.xyz/runs/latest/info_embed.html"
      echo "   Puis : ./rebuild-poi-db.sh --with-external --atp-zip <output.zip>"
    else
      echo ""
      echo "── AllThePlaces…"
      nice -n 10 node import-atp.mjs --zip "$ATP_ZIP" --db "$OUT" --enrich
    fi
  fi
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
const cols=db.prepare(\"SELECT name FROM pragma_table_info('pois')\").all().map(r=>r.name);
if (cols.includes('source')) {
  console.log('Par source :');
  for (const r of db.prepare('SELECT coalesce(source,\'osm\') s, count(*) n FROM pois GROUP BY 1 ORDER BY 2 DESC').all())
    console.log('   ', String(r.n).padStart(9), r.s);
}
"

if [[ $DO_SWAP -eq 1 ]]; then
  echo ""
  ./swap-db.sh "$OUT"
else
  echo ""
  echo "➡️  Pour basculer le service : ./swap-db.sh $OUT"
fi
