#!/usr/bin/env node
/**
 * RedView — fusion des doublons géométriques d'une catégorie surfacique.
 *
 * Un même lieu est souvent cartographié deux fois dans OSM : l'enclos
 * paroissial `amenity=grave_yard` dessiné à l'intérieur du `landuse=cemetery`,
 * un cimetière en multipolygone dont un morceau est aussi un way étiqueté…
 * Les deux centroïdes tombent à quelques dizaines de mètres : la feuille de
 * route montrerait deux « Cimetière » au même kilomètre.
 *
 * Suppression des non-maxima, dans une seule catégorie : les POI sont triés
 * du plus informatif au moins informatif (nommé, puis relation > way > node),
 * chacun gardé supprime ceux de la même catégorie à moins de `--radius`
 * mètres. Pas de chaînage : deux cimetières distincts à 2 × R restent deux.
 *
 * Idempotent. Usage :
 *   node collapse-overlaps.mjs --db data/pois.new.db --category cemetery --radius 80
 *   node collapse-overlaps.mjs --db data/pois.new.db --category cemetery --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const args = { db: null, category: null, radius: 80, dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') args.db = argv[++i];
  else if (a === '--category') args.category = argv[++i];
  else if (a === '--radius') args.radius = Number(argv[++i]);
  else if (a === '--dry-run') args.dryRun = true;
}
if (!args.db || !args.category || !(args.radius > 0)) {
  console.error('Usage: node collapse-overlaps.mjs --db <db.sqlite> --category <clé> [--radius 80] [--dry-run]');
  process.exit(1);
}
const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
  console.error(`❌ Base introuvable : ${dbPath}`);
  process.exit(1);
}

const TYPE_RANK = { relation: 2, way: 1, node: 0 };
const M_PER_DEG_LAT = 111_320;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const rows = db.prepare('SELECT id, lat, lon, name, osm_type FROM pois WHERE category = ?').all(args.category);
rows.sort((a, b) => (
  (b.name ? 1 : 0) - (a.name ? 1 : 0)
  || (TYPE_RANK[b.osm_type] ?? 0) - (TYPE_RANK[a.osm_type] ?? 0)
  || a.id - b.id
));

// Grille de R × R degrés-latitude : en longitude une cellule fait R·cos(lat)
// mètres, d'où ±ceil(1 / cos(lat)) cellules à parcourir.
const cell = args.radius / M_PER_DEG_LAT;
const kept = new Map();
const removed = [];
const cellKey = (x, y) => `${x}:${y}`;

for (const poi of rows) {
  const cosLat = Math.max(0.05, Math.cos((poi.lat * Math.PI) / 180));
  const spanX = Math.ceil(1 / cosLat);
  const cx = Math.floor(poi.lon / cell);
  const cy = Math.floor(poi.lat / cell);
  let duplicate = false;
  for (let dx = -spanX; dx <= spanX && !duplicate; dx++) {
    for (let dy = -1; dy <= 1 && !duplicate; dy++) {
      for (const other of kept.get(cellKey(cx + dx, cy + dy)) ?? []) {
        const d = Math.hypot((poi.lat - other.lat) * M_PER_DEG_LAT, (poi.lon - other.lon) * M_PER_DEG_LAT * cosLat);
        if (d <= args.radius) { duplicate = true; break; }
      }
    }
  }
  if (duplicate) { removed.push(poi.id); continue; }
  const key = cellKey(cx, cy);
  const bucket = kept.get(key);
  if (bucket) bucket.push(poi);
  else kept.set(key, [poi]);
}

console.log(`🔎 ${args.category} : ${rows.length.toLocaleString('fr-FR')} POI, ${removed.length.toLocaleString('fr-FR')} doublons à moins de ${args.radius} m`);
if (!args.dryRun && removed.length) {
  const delPoi = db.prepare('DELETE FROM pois WHERE id = ?');
  const delRtree = db.prepare('DELETE FROM poi_rtree WHERE id = ?');
  db.transaction((ids) => {
    for (const id of ids) { delPoi.run(id); delRtree.run(id); }
  })(removed);
  console.log(`✅ ${removed.length.toLocaleString('fr-FR')} supprimés — reste ${(rows.length - removed.length).toLocaleString('fr-FR')}`);
}
db.close();
