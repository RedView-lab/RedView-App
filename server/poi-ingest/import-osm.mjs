#!/usr/bin/env node
/**
 * RedView — importeur POI OSM (nodes + ways) vers SQLite/R*Tree.
 *
 * Remplace `parse-pbf.js`, dont la ligne
 *     if (item.type !== 'node') continue;
 * jetait TOUS les POI cartographiés en bâtiment (way) ou en relation —
 * c'est-à-dire la majorité des restaurants, hôtels, supermarchés, campings
 * et refuges de France. C'est la cause directe des POI « manquants »
 * (ex. le restaurant/hôtel Pietra Monetta à Palasca, en Corse).
 *
 * Algorithme (2 passes sur le PBF, mémoire bornée, staging sur disque) :
 *
 *   Phase 1  ways   → matche la taxonomie, stocke {category, tags, refs} dans
 *                     `stg_ways` ; accumule les node ids référencés.
 *   Phase 2  tri + dédoublonnage des node ids (Float64Array trié).
 *   Phase 3  nodes  → résout les coordonnées des seuls node ids utiles
 *                     (merge-join linéaire, repli dichotomique si le PBF
 *                     n'est pas trié par id) → `stg_nodes`.
 *   Phase 4  calcul des centroïdes de ways, insertion dans `pois` + `poi_rtree`.
 *   Phase 5  (option --relations) relations via Overpass `out center`.
 *   Phase 6  nettoyage du staging.
 *
 * Identifiants : node = osm_id (rétrocompatible avec la base existante),
 * way = 1e13 + osm_id, relation = 2e13 + osm_id. Les namespaces OSM sont
 * disjoints, un way ne peut donc plus écraser un node homonyme (bug latent
 * de l'ancien importeur, qui utilisait `INSERT OR REPLACE` sur `id`).
 *
 * Usage :
 *   node import-osm.mjs --pbf /tmp/france.osm.pbf --out data/pois.new.db
 *   node import-osm.mjs --pbf /tmp/corse.osm.pbf --out /tmp/test.db --limit 200000
 *   node import-osm.mjs --pbf /tmp/france.osm.pbf --out data/pois.new.db --relations
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import parseOSM from 'osm-pbf-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NODE_ID_BASE = 0;
const WAY_ID_BASE = 10_000_000_000_000;      // 1e13
const RELATION_ID_BASE = 20_000_000_000_000; // 2e13

// ── Args ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { pbf: [], out: null, taxonomy: null, limit: 0, relations: false, bbox: null, keepStaging: false, verbose: false, force: false, append: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pbf') out.pbf.push(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--taxonomy') out.taxonomy = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10) || 0;
    else if (a === '--bbox') out.bbox = argv[++i];
    else if (a === '--relations') out.relations = true;
    else if (a === '--keep-staging') out.keepStaging = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--force') out.force = true;
    else if (a === '--append') out.append = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.pbf.length === 0 || !args.out) {
  console.error('Usage: node import-osm.mjs --pbf <file.osm.pbf> [--pbf ...] --out <db.sqlite> [--limit N] [--relations] [--bbox s,w,n,e]');
  process.exit(1);
}
for (const f of args.pbf) {
  if (!fs.existsSync(f)) { console.error(`❌ PBF introuvable : ${f}`); process.exit(1); }
}

const taxonomyPath = args.taxonomy || path.resolve(__dirname, 'poi-taxonomy.json');
const taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf8'));
const KEEP_TAGS = new Set(taxonomy.keepTags || []);

console.log(`📚 Taxonomie : ${taxonomy.categories.length} catégories (v${taxonomy.version}) — ${path.basename(taxonomyPath)}`);
console.log(`🗂️  Fichiers PBF : ${args.pbf.length}`);
for (const f of args.pbf) console.log(`     • ${f} (${(fs.statSync(f).size / 1e6).toFixed(0)} Mo)`);

// ── Matching des tags ─────────────────────────────────────────────────

function condMatches(tags, cond) {
  const v = tags[cond.k];
  if (v == null) return false;
  if (cond.v != null) return v === cond.v;
  if (Array.isArray(cond.in)) return cond.in.includes(v);
  return false;
}

function ruleMatches(tags, rule) {
  for (const cond of rule) {
    if (!condMatches(tags, cond)) return false;
  }
  return true;
}

/** Retourne la clé de catégorie, ou null. */
function resolveCategory(tags) {
  if (!tags) return null;
  for (const cat of taxonomy.categories) {
    for (const rule of cat.rules) {
      if (ruleMatches(tags, rule)) return cat.key;
    }
  }
  return null;
}

function buildName(tags) {
  return (
    tags.name
    || tags['name:fr']
    || tags['name:en']
    || tags.alt_name
    || tags.brand
    || tags.operator
    || null
  );
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

// ── Base de données ───────────────────────────────────────────────────

const outPath = path.resolve(args.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
if (!args.append) {
  if (fs.existsSync(outPath) && !args.force) {
    const existing = new Database(outPath, { readonly: true });
    let looksLive = false;
    try {
      looksLive = (existing.prepare('SELECT count(*) AS n FROM pois').get()?.n ?? 0) > 0;
    } catch { /* base vide ou schéma absent */ }
    existing.close();
    if (looksLive) {
      console.error(`❌ ${outPath} contient déjà des POI. Refus d'écraser une base existante sans --force.`);
      console.error('   Utilise un fichier de sortie neuf (ex. data/pois.new.db) puis bascule-le,');
      console.error('   ou --append pour ajouter une région supplémentaire à une base en construction.');
      process.exit(1);
    }
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const p = outPath + suffix;
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

const db = new Database(outPath);
db.pragma('journal_mode = OFF');       // import massif : pas de WAL, on repasse en WAL à la fin
db.pragma('synchronous = OFF');
db.pragma('cache_size = -131072');     // 128 Mo
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS pois (
    id INTEGER PRIMARY KEY,
    osm_id INTEGER,
    osm_type TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    category TEXT NOT NULL,
    name TEXT,
    tags TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pois_category ON pois(category);
  CREATE VIRTUAL TABLE IF NOT EXISTS poi_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
  DROP TABLE IF EXISTS stg_ways;
  DROP TABLE IF EXISTS stg_nodes;
  CREATE TABLE stg_ways (
    id INTEGER PRIMARY KEY,
    category TEXT,
    name TEXT,
    tags TEXT,
    refs BLOB
  );
  CREATE TABLE stg_nodes (
    node_id INTEGER PRIMARY KEY,
    lat REAL,
    lon REAL
  ) WITHOUT ROWID;
`);

const insStgWay = db.prepare('INSERT INTO stg_ways (id, category, name, tags, refs) VALUES (?, ?, ?, ?, ?)');
const insStgNode = db.prepare('INSERT OR IGNORE INTO stg_nodes (node_id, lat, lon) VALUES (?, ?, ?)');
const insPoi = db.prepare('INSERT OR REPLACE INTO pois (id, osm_id, osm_type, lat, lon, category, name, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const insRtree = db.prepare('INSERT OR REPLACE INTO poi_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)');
const getNode = db.prepare('SELECT lat, lon FROM stg_nodes WHERE node_id = ?');

const insertPoisTx = db.transaction((rows) => {
  for (const r of rows) {
    insPoi.run(r.id, r.osmId, r.osmType, r.lat, r.lon, r.category, r.name, r.tags);
    insRtree.run(r.id, r.lon, r.lon, r.lat, r.lat);
  }
});

// ── Accumulateur de node ids ──────────────────────────────────────────

const CHUNK = 1 << 22; // 4 M ids par bloc
const refChunks = [];
let curChunk = new Float64Array(CHUNK);
let curLen = 0;
let totalRefs = 0;

function pushRef(id) {
  if (curLen === CHUNK) {
    refChunks.push(curChunk);
    curChunk = new Float64Array(CHUNK);
    curLen = 0;
  }
  curChunk[curLen++] = id;
  totalRefs++;
}

function drainRefs() {
  if (curLen > 0) { refChunks.push(curChunk.subarray(0, curLen)); curLen = 0; }
  const total = refChunks.reduce((a, c) => a + c.length, 0);
  const flat = new Float64Array(total);
  let off = 0;
  for (const c of refChunks) { flat.set(c, off); off += c.length; }
  refChunks.length = 0;
  curChunk = new Float64Array(0);
  return flat;
}

// ── Streaming PBF ─────────────────────────────────────────────────────

function streamPbf(file, onItems) {
  return new Promise((resolve, reject) => {
    const osm = parseOSM();
    fs.createReadStream(file)
      .pipe(osm)
      .on('data', (items) => {
        try { onItems(items); } catch (err) { reject(err); }
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

// ── Phase 1 : ways ────────────────────────────────────────────────────

console.log('\n▶️  Phase 1/5 — lecture des ways…');
let wayScanned = 0;
let wayMatched = 0;

const insertWaysTx = db.transaction((rows) => {
  for (const r of rows) insStgWay.run(r.id, r.category, r.name, r.tags, r.refs);
});

for (const pbf of args.pbf) {
  let buffer = [];
  await streamPbf(pbf, (items) => {
    for (const item of items) {
      if (item.type !== 'way') continue;
      wayScanned++;
      if (wayScanned % 2_000_000 === 0) {
        process.stdout.write(`\r   ways lus: ${(wayScanned / 1e6).toFixed(1)}M — retenus: ${wayMatched} (${elapsed()})   `);
      }
      const cat = resolveCategory(item.tags);
      if (!cat) continue;
      if (args.limit && wayMatched >= args.limit) continue;
      const refs = item.refs;
      if (!refs || refs.length === 0) continue;

      const refBuf = Buffer.allocUnsafe(refs.length * 8);
      for (let i = 0; i < refs.length; i++) {
        const nid = refs[i];
        refBuf.writeDoubleLE(nid, i * 8);
        pushRef(nid);
      }

      buffer.push({
        id: item.id,
        category: cat,
        name: buildName(item.tags || {}),
        tags: buildTagsJson(item.tags || {}),
        refs: refBuf,
      });
      wayMatched++;

      if (buffer.length >= 20_000) { insertWaysTx(buffer); buffer = []; }
    }
  });
  if (buffer.length) { insertWaysTx(buffer); buffer = []; }
}
console.log(`\r   ✅ ${wayScanned.toLocaleString('fr-FR')} ways lus, ${wayMatched.toLocaleString('fr-FR')} retenus (${elapsed()})            `);

// ── Phase 2 : tri + dédoublonnage des node ids ────────────────────────

console.log('▶️  Phase 2/5 — tri des node ids référencés…');
const refs = drainRefs();
console.log(`   ${totalRefs.toLocaleString('fr-FR')} références (${(refs.byteLength / 1e6).toFixed(0)} Mo) — tri…`);
refs.sort();
let unique = 0;
for (let i = 0; i < refs.length; i++) {
  if (i === 0 || refs[i] !== refs[i - 1]) refs[unique++] = refs[i];
}
const needed = refs.subarray(0, unique);
console.log(`   ✅ ${unique.toLocaleString('fr-FR')} node ids uniques à résoudre (${elapsed()})`);

// ── Phase 3 : nodes — indexation POI + résolution des coordonnées ─────
//
// Une seule passe de nodes pour deux besoins :
//   a) indexer les POI cartographiés en node (fontaines, bornes, etc.),
//   b) résoudre les coordonnées des nodes référencés par les ways retenus.

console.log('▶️  Phase 3/5 — nodes : indexation POI + résolution des coordonnées…');
let nodeScanned = 0;
let nodeResolved = 0;
let nodePois = 0;
let cursor = 0;
let monotonic = true;
let lastId = -1;

const insertNodesTx = db.transaction((rows) => {
  for (const r of rows) insStgNode.run(r.id, r.lat, r.lon);
});

function binarySearch(arr, target) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

for (const pbf of args.pbf) {
  let buffer = [];
  let poiBuffer = [];
  await streamPbf(pbf, (items) => {
    for (const item of items) {
      if (item.type !== 'node') continue;
      nodeScanned++;
      const id = item.id;

      // (a) POI en node
      const cat = resolveCategory(item.tags);
      if (cat) {
        poiBuffer.push({
          id: NODE_ID_BASE + id,
          osmId: id,
          osmType: 'node',
          lat: item.lat,
          lon: item.lon,
          category: cat,
          name: buildName(item.tags || {}),
          tags: buildTagsJson(item.tags || {}),
        });
        nodePois++;
        if (poiBuffer.length >= 20_000) { insertPoisTx(poiBuffer); poiBuffer = []; }
      }

      // (b) coordonnée utile à un way
      let wanted = false;
      if (monotonic) {
        if (id < lastId) monotonic = false;
        else {
          while (cursor < needed.length && needed[cursor] < id) cursor++;
          wanted = cursor < needed.length && needed[cursor] === id;
        }
      }
      if (!wanted && !monotonic) wanted = binarySearch(needed, id) >= 0;
      if (!wanted) continue;

      buffer.push({ id, lat: item.lat, lon: item.lon });
      nodeResolved++;
      if (buffer.length >= 50_000) { insertNodesTx(buffer); buffer = []; }
    }
    process.stdout.write(`\r   nodes lus: ${(nodeScanned / 1e6).toFixed(1)}M — POI node: ${nodePois.toLocaleString('fr-FR')} — refs résolues: ${nodeResolved.toLocaleString('fr-FR')} (${elapsed()})   `);
  });
  if (buffer.length) { insertNodesTx(buffer); buffer = []; }
  if (poiBuffer.length) { insertPoisTx(poiBuffer); poiBuffer = []; }
}
console.log(`\r   ✅ ${nodeScanned.toLocaleString('fr-FR')} nodes lus — ${nodePois.toLocaleString('fr-FR')} POI node, ${nodeResolved.toLocaleString('fr-FR')} refs résolues (${elapsed()})            `);
if (!monotonic) console.log('   ℹ️  PBF non trié par id : repli en recherche dichotomique.');

// ── Phase 4 : centroïdes des ways ─────────────────────────────────────

console.log('▶️  Phase 4/5 — calcul des centroïdes et insertion des POI…');
let inserted = 0;
let orphan = 0;
let readWays = 0;
let buffer = [];

// Pagination par clé (pas d'OFFSET, pas d'itérateur ouvert pendant les
// écritures : better-sqlite3 n'autorise pas une transaction au milieu d'un
// curseur).
const PAGE = 20_000;
const pageWays = db.prepare('SELECT id, category, name, tags, refs FROM stg_ways WHERE id > ? ORDER BY id LIMIT ?');
let lastWayId = 0;

for (;;) {
  const rows = pageWays.all(lastWayId, PAGE);
  if (rows.length === 0) break;

  for (const row of rows) {
    lastWayId = row.id;
    readWays++;
    const buf = row.refs;
    const count = buf.length / 8;
    let sumLat = 0;
    let sumLon = 0;
    let found = 0;

    for (let i = 0; i < count; i++) {
      const nid = buf.readDoubleLE(i * 8);
      const n = getNode.get(nid);
      if (!n) continue;
      sumLat += n.lat;
      sumLon += n.lon;
      found++;
    }

    if (found === 0) { orphan++; continue; }

    buffer.push({
      id: WAY_ID_BASE + row.id,
      osmId: row.id,
      osmType: 'way',
      lat: sumLat / found,
      lon: sumLon / found,
      category: row.category,
      name: row.name,
      tags: row.tags,
    });
    inserted++;
  }

  if (buffer.length) {
    insertPoisTx(buffer);
    buffer = [];
  }
  process.stdout.write(`\r   ways traités: ${readWays.toLocaleString('fr-FR')} — POI insérés: ${inserted.toLocaleString('fr-FR')} (${elapsed()})   `);
}
console.log(`\r   ✅ ${inserted.toLocaleString('fr-FR')} POI « way » insérés (${orphan} sans node résolu) (${elapsed()})            `);

// ── Phase 5 : relations via Overpass (optionnel) ──────────────────────

if (args.relations) {
  console.log('▶️  Phase 5/5 — relations via Overpass…');
  const bbox = args.bbox || '-5.5,41.0,9.9,51.5'; // west,south,east,north
  const [w, s, e, n] = bbox.split(',').map(Number);
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
  ];

  const blocks = [];
  for (const cat of taxonomy.categories) {
    for (const rule of cat.rules) {
      if (rule.length !== 1) continue; // les règles AND ne visent pas les multipolygones
      const { k, v, in: values } = rule[0];
      if (v != null) blocks.push({ cat: cat.key, q: `relation["${k}"="${v}"](${s},${w},${n},${e});` });
      else if (Array.isArray(values)) {
        for (const val of values) blocks.push({ cat: cat.key, q: `relation["${k}"="${val}"](${s},${w},${n},${e});` });
      }
    }
  }

  const relBuffer = [];
  for (const b of blocks) {
    const ql = `[out:json][timeout:170];\n${b.q}\nout center;`;
    let data = null;
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8', Accept: 'application/json', 'User-Agent': 'RedView/1.0 (+https://redview.tech)' },
          body: ql,
          signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) continue;
        data = await res.json();
        break;
      } catch { /* endpoint suivant */ }
    }
    if (!data?.elements) { console.warn(`   ⚠️  ${b.q.slice(0, 60)}… indisponible`); continue; }
    for (const el of data.elements) {
      const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
      if (!c) continue;
      relBuffer.push({
        id: RELATION_ID_BASE + el.id,
        osmId: el.id,
        osmType: 'relation',
        lat: c.lat,
        lon: c.lon,
        category: b.cat,
        name: buildName(el.tags || {}),
        tags: buildTagsJson(el.tags || {}),
      });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (relBuffer.length) {
    for (let i = 0; i < relBuffer.length; i += 10_000) {
      insertPoisTx(relBuffer.slice(i, i + 10_000));
    }
  }
  console.log(`   ✅ ${relBuffer.length} POI « relation » insérés`);
}

// ── Phase 6 : nettoyage ───────────────────────────────────────────────

console.log('▶️  Phase 6 — indexation et nettoyage…');
if (!args.keepStaging) {
  db.exec('DROP TABLE IF EXISTS stg_ways; DROP TABLE IF EXISTS stg_nodes;');
}
db.exec('ANALYZE;');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec('PRAGMA optimize;');

const total = db.prepare('SELECT count(*) AS n FROM pois').get().n;
const byCat = db.prepare('SELECT category, count(*) AS n FROM pois GROUP BY category ORDER BY n DESC').all();
console.log(`\n🎉 Import terminé : ${total.toLocaleString('fr-FR')} POI en ${elapsed()}`);
for (const r of byCat) console.log(`   ${String(r.n).padStart(9)}  ${r.category}`);
console.log(`\n📁 ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(0)} Mo)`);
db.close();
