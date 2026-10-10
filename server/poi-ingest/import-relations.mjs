#!/usr/bin/env node
/**
 * RedView — import des POI cartographiés en **relation** OSM (multipolygones).
 *
 * L'importeur PBF (`import-osm.mjs`) couvre les nodes et les ways. Les
 * relations restent hors de portée d'un parcours PBF en deux passes (leurs
 * membres sont des nodes ET des ways, dont il faudrait relire les géométries).
 *
 * Elles sont peu nombreuses mais structurantes : campings, hôpitaux et
 * supermarchés sont souvent cartographiés en multipolygone, et ce sont
 * précisément les catégories où la couverture de la base était la plus
 * faible (13,6 % pour les campings).
 *
 * Ce script est **idempotent et rejouable** : il écrit en INSERT OR REPLACE
 * avec un id préfixé (2e13 + id de relation), donc relancer l'import ne
 * duplique rien et n'écrase aucun node ni way.
 *
 * Usage :
 *   node import-relations.mjs --db data/pois.db
 *   node import-relations.mjs --db data/pois.db --bbox -5.5,41.0,9.9,51.5
 *   node import-relations.mjs --db data/pois.db --dry-run
 *   node import-relations.mjs --db data/pois.new.db --categories cemetery --border france-border.json
 *
 * `--categories` limite les requêtes aux catégories citées ; `--border` ne
 * garde que les relations dont le centre est dans ce territoire (GeoJSON
 * MultiPolygon) — la boîte France contient Genève, Bâle, Bruxelles…
 *
 * `--dedupe` : obligatoire sur une base déjà complétée par Overture, SIRENE
 * ou AllThePlaces, qui ont été dédoublonnées contre une base SANS relations.
 * Un lieu déjà présent en node / way OSM n'est pas réimporté ; un lieu
 * présent seulement en source externe est remplacé par la relation OSM (la
 * source de référence), qui reprend ses téléphone / site / horaires absents.
 *
 * Sortie 2 si une requête Overpass a échoué : l'import est alors partiel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DedupeIndex } from './lib/dedupe.mjs';
import { rasterizeMultiPolygon } from './lib/geo.mjs';
import { makeResolveCategory, parseCategoryList, ruleToOverpassFilter } from './lib/taxonomy-rules.mjs';

const RELATION_ID_BASE = 20_000_000_000_000; // 2e13

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = { db: null, taxonomy: null, bbox: '-5.5,41.0,9.9,51.5', dryRun: false, verbose: false, categories: null, border: null, dedupe: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') args.db = argv[++i];
  else if (a === '--taxonomy') args.taxonomy = argv[++i];
  else if (a === '--bbox') args.bbox = argv[++i];
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--verbose') args.verbose = true;
  else if (a === '--categories') args.categories = argv[++i];
  else if (a === '--border') args.border = argv[++i];
  else if (a === '--dedupe') args.dedupe = true;
}
if (!args.db) {
  console.error('Usage: node import-relations.mjs --db <db.sqlite> [--bbox west,south,east,north] [--categories a,b] [--border <geojson>] [--dedupe] [--dry-run]');
  process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
  console.error(`❌ Base introuvable : ${dbPath}`);
  process.exit(1);
}

const taxonomy = JSON.parse(fs.readFileSync(args.taxonomy || path.resolve(__dirname, 'poi-taxonomy.json'), 'utf8'));
const KEEP_TAGS = new Set(taxonomy.keepTags || []);

let onlyCategories;
try {
  onlyCategories = parseCategoryList(taxonomy, args.categories);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
const resolveCategory = makeResolveCategory(taxonomy, onlyCategories);

let border = null;
if (args.border) {
  if (!fs.existsSync(args.border)) {
    console.error(`❌ Frontière introuvable : ${args.border}`);
    process.exit(1);
  }
  border = rasterizeMultiPolygon(JSON.parse(fs.readFileSync(args.border, 'utf8')));
}

const [w, s, e, n] = args.bbox.split(',').map(Number);
if ([w, s, e, n].some((v) => !Number.isFinite(v))) {
  console.error('❌ --bbox attendu sous la forme west,south,east,north');
  process.exit(1);
}

// Instances mondiales seulement : une instance régionale (overpass.osm.ch :
// la Suisse) répond vite et « avec succès » avec un extrait — 16 cimetières en
// relation au lieu de ~1 400 le 2026-10-10.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function buildName(tags) {
  return tags.name || tags['name:fr'] || tags['name:en'] || tags.alt_name || tags.brand || tags.operator || null;
}

function buildTagsJson(tags) {
  const kept = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k === 'name' || k === 'name:fr') { kept[k] = v; continue; }
    if (!KEEP_TAGS.has(k)) continue;
    if (typeof v === 'string' && v.length > 300) { kept[k] = v.slice(0, 300); continue; }
    kept[k] = v;
  }
  return JSON.stringify(kept);
}

async function overpass(ql) {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
            Accept: 'application/json',
            'User-Agent': 'RedView/1.0 (+https://redview.tech)',
          },
          body: ql,
          signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
        const data = await res.json();
        if (data?.remark && /error|timed?\s?out|rate_limited/i.test(String(data.remark))) {
          lastErr = String(data.remark).slice(0, 80);
          continue;
        }
        return data;
      } catch (err) {
        lastErr = err.message;
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Overpass indisponible (${lastErr})`);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

const insPoi = db.prepare(
  'INSERT OR REPLACE INTO pois (id, osm_id, osm_type, lat, lon, category, name, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const insRtree = db.prepare(
  'INSERT OR REPLACE INTO poi_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
);
const delPoi = db.prepare('DELETE FROM pois WHERE id = ?');
const delRtree = db.prepare('DELETE FROM poi_rtree WHERE id = ?');
const insertTx = db.transaction((rows) => {
  for (const r of rows) {
    for (const id of r.replaces ?? []) { delPoi.run(id); delRtree.run(id); }
    insPoi.run(r.id, r.osmId, 'relation', r.lat, r.lon, r.category, r.name, r.tags);
    insRtree.run(r.id, r.lon, r.lon, r.lat, r.lat);
  }
});

/** Clés qu'une relation reprend d'un doublon externe quand elle ne les a pas. */
const CARRY_OVER_TAGS = ['phone', 'contact:phone', 'website', 'contact:website', 'opening_hours', 'brand', 'email'];

let dedupeIndex = null;
const sourceById = new Map();
if (args.dedupe) {
  console.log('🧮 Index de dédoublonnage…');
  dedupeIndex = new DedupeIndex();
  dedupeIndex.buildFromDb(db);
  for (const r of db.prepare('SELECT id, source, category FROM pois').iterate()) {
    sourceById.set(r.id, { source: r.source, category: r.category });
  }
  console.log(`   ${dedupeIndex.size.toLocaleString('fr-FR')} POI indexés`);
}
const dedupeStats = { skippedOsm: 0, replacedExternal: 0 };

/**
 * Doublon d'une relation : null (nouvelle), 'skip' (déjà en node / way OSM),
 * ou l'entrée externe à remplacer. Même catégorie exigée.
 */
function resolveDuplicate(row, tags) {
  if (!dedupeIndex) return null;
  const match = dedupeIndex.findMatch({ lat: row.lat, lon: row.lon, category: row.category, name: row.name, tags });
  if (!match) return null;
  const existing = sourceById.get(match.id);
  if (!existing || existing.category !== row.category) return null;
  if (match.id >= RELATION_ID_BASE && match.id < RELATION_ID_BASE + 1e13) return 'skip'; // relation déjà importée
  return existing.source == null ? 'skip' : match;
}

// Une requête Overpass par (catégorie, règle).
const jobs = [];
for (const cat of taxonomy.categories) {
  if (onlyCategories && !onlyCategories.includes(cat.key)) continue;
  for (const rule of cat.rules) {
    const filter = ruleToOverpassFilter(rule);
    if (filter) jobs.push({ category: cat.key, filter });
  }
}

console.log(`🔎 ${jobs.length} requêtes de relations sur bbox ${args.bbox}`);
if (args.dryRun) {
  for (const j of jobs) console.log(`   relation${j.filter} → ${j.category}`);
  process.exit(0);
}

let totalInserted = 0;
let done = 0;
let failedJobs = 0;
const perCategory = new Map();

/**
 * Relations d'un filtre dans une boîte. Les catégories denses (cimetières :
 * ~1 400 relations sur la France, avec leur centre) dépassent ce que les
 * instances publiques calculent en une requête (HTTP 500 / délai) : sur un
 * échec, la boîte est coupée en 4, jusqu'à 3 niveaux (64 tuiles).
 */
async function fetchRelations(filter, [south, west, north, east], depth = 0) {
  const ql = `[out:json][timeout:170];\nrelation${filter}(${south},${west},${north},${east});\nout center;`;
  try {
    return (await overpass(ql)).elements || [];
  } catch (err) {
    if (depth >= 3) throw err;
    const midLat = (south + north) / 2;
    const midLon = (west + east) / 2;
    const byId = new Map();
    for (const tile of [[south, west, midLat, midLon], [south, midLon, midLat, east], [midLat, west, north, midLon], [midLat, midLon, north, east]]) {
      for (const el of await fetchRelations(filter, tile, depth + 1)) byId.set(el.id, el);
      await new Promise((r) => setTimeout(r, 1500));
    }
    return [...byId.values()];
  }
}

for (const job of jobs) {
  done++;
  let elements;
  try {
    elements = await fetchRelations(job.filter, [s, w, n, e]);
  } catch (err) {
    console.warn(`\r   ⚠️  ${job.filter} : ${err.message}`);
    failedJobs++;
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }

  const rows = [];
  for (const el of elements) {
    const center = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!center) continue;
    if (border && !border.contains(center.lon, center.lat)) continue;
    // Même priorité que l'import PBF : une relation que la taxonomie range
    // dans une catégorie plus prioritaire n'est pas réétiquetée ici.
    if (resolveCategory(el.tags) !== job.category) continue;
    const row = {
      id: RELATION_ID_BASE + el.id,
      osmId: el.id,
      lat: center.lat,
      lon: center.lon,
      category: job.category,
      name: buildName(el.tags || {}),
      tags: buildTagsJson(el.tags || {}),
    };
    const duplicate = resolveDuplicate(row, el.tags || {});
    if (duplicate === 'skip') { dedupeStats.skippedOsm++; continue; }
    if (duplicate) {
      const tags = JSON.parse(row.tags);
      const external = JSON.parse(db.prepare('SELECT tags FROM pois WHERE id = ?').get(duplicate.id)?.tags || '{}');
      for (const k of CARRY_OVER_TAGS) if (tags[k] == null && external[k] != null) tags[k] = external[k];
      row.tags = JSON.stringify(tags);
      row.replaces = [duplicate.id];
      sourceById.delete(duplicate.id);
      dedupeStats.replacedExternal++;
    }
    dedupeIndex?.accept({ ...row, tags: el.tags || {} });
    sourceById.set(row.id, { source: null, category: row.category });
    rows.push(row);
  }

  if (rows.length) {
    insertTx(rows);
    totalInserted += rows.length;
    perCategory.set(job.category, (perCategory.get(job.category) || 0) + rows.length);
  }
  process.stdout.write(`\r   ${done}/${jobs.length} — ${totalInserted} relations insérées   `);
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\n✅ ${totalInserted} relations insérées`);
for (const [cat, count] of [...perCategory.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(count).padStart(6)}  ${cat}`);
}
if (dedupeIndex) {
  console.log(`🧹 Dédoublonnage : ${dedupeStats.skippedOsm} déjà en node / way OSM (ignorées), ${dedupeStats.replacedExternal} doublons externes remplacés`);
}
const total = db.prepare('SELECT count(*) AS n FROM pois').get().n;
console.log(`📊 Total base : ${total.toLocaleString('fr-FR')} POI`);
db.close();
if (failedJobs > 0) {
  console.error(`❌ ${failedJobs} requête(s) Overpass en échec : import partiel.`);
  process.exit(2);
}
