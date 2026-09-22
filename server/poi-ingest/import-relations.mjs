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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const RELATION_ID_BASE = 20_000_000_000_000; // 2e13

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = { db: null, taxonomy: null, bbox: '-5.5,41.0,9.9,51.5', dryRun: false, verbose: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') args.db = argv[++i];
  else if (a === '--taxonomy') args.taxonomy = argv[++i];
  else if (a === '--bbox') args.bbox = argv[++i];
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--verbose') args.verbose = true;
}
if (!args.db) {
  console.error('Usage: node import-relations.mjs --db <db.sqlite> [--bbox west,south,east,north] [--dry-run]');
  process.exit(1);
}

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
  console.error(`❌ Base introuvable : ${dbPath}`);
  process.exit(1);
}

const taxonomy = JSON.parse(fs.readFileSync(args.taxonomy || path.resolve(__dirname, 'poi-taxonomy.json'), 'utf8'));
const KEEP_TAGS = new Set(taxonomy.keepTags || []);

const [w, s, e, n] = args.bbox.split(',').map(Number);
if ([w, s, e, n].some((v) => !Number.isFinite(v))) {
  console.error('❌ --bbox attendu sous la forme west,south,east,north');
  process.exit(1);
}

const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass-api.de/api/interpreter',
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
const insertTx = db.transaction((rows) => {
  for (const r of rows) {
    insPoi.run(r.id, r.osmId, 'relation', r.lat, r.lon, r.category, r.name, r.tags);
    insRtree.run(r.id, r.lon, r.lon, r.lat, r.lat);
  }
});

// Une requête Overpass par (catégorie, condition simple).
const jobs = [];
for (const cat of taxonomy.categories) {
  for (const rule of cat.rules) {
    if (rule.length !== 1) continue; // les règles AND ne décrivent pas des multipolygones
    const { k, v, in: values } = rule[0];
    if (v != null) jobs.push({ category: cat.key, k, v });
    else if (Array.isArray(values)) for (const value of values) jobs.push({ category: cat.key, k, v: value });
  }
}

console.log(`🔎 ${jobs.length} requêtes de relations sur bbox ${args.bbox}`);
if (args.dryRun) {
  for (const j of jobs) console.log(`   relation["${j.k}"="${j.v}"] → ${j.category}`);
  process.exit(0);
}

let totalInserted = 0;
let done = 0;
const perCategory = new Map();

for (const job of jobs) {
  done++;
  const ql = `[out:json][timeout:170];\nrelation["${job.k}"="${job.v}"](${s},${w},${n},${e});\nout center;`;
  let data;
  try {
    data = await overpass(ql);
  } catch (err) {
    console.warn(`\r   ⚠️  ${job.k}=${job.v} : ${err.message}`);
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }

  const rows = [];
  for (const el of data.elements || []) {
    const center = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!center) continue;
    rows.push({
      id: RELATION_ID_BASE + el.id,
      osmId: el.id,
      lat: center.lat,
      lon: center.lon,
      category: job.category,
      name: buildName(el.tags || {}),
      tags: buildTagsJson(el.tags || {}),
    });
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
const total = db.prepare('SELECT count(*) AS n FROM pois').get().n;
console.log(`📊 Total base : ${total.toLocaleString('fr-FR')} POI`);
db.close();
