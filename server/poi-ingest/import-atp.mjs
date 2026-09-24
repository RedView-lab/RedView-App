#!/usr/bin/env node
/**
 * RedView — import des POI **AllThePlaces** (alltheplaces.xyz).
 *
 * AllThePlaces gratte les sites de chaînes et publie un GeoJSON par marque.
 * Deux particularités qui simplifient beaucoup l'import :
 *
 *   1. **Les catégories sont déjà en tags OSM** (`amenity=fast_food`,
 *      `shop=supermarket`…) posés directement sur les propriétés GeoJSON.
 *      Aucune table de correspondance n'est nécessaire : la taxonomie RedView
 *      s'applique telle quelle, exactement comme pour `import-osm.mjs`.
 *   2. **Le pays est dans le nom de fichier** (`*_fr.geojson`). Mais les
 *      marques mondiales (`shell.geojson`, `moneygram.geojson`) n'ont pas de
 *      suffixe : il faut alors tester la géométrie.
 *
 * Mesuré sur le run 2026-09-19 : 286 587 lieux en France, dont 97 511 tombent
 * dans nos 46 catégories. L'apport net est faible (~15 000) car ces chaînes
 * sont déjà massivement cartographiées dans OSM — mais ce sont les ouvertures
 * récentes et les franchisés oubliés qui font la différence.
 *
 * Usage :
 *   node import-atp.mjs --zip output.zip --db data/pois.db
 *   node import-atp.mjs --zip output.zip --db data/pois.db --dry-run
 *   node import-atp.mjs --zip output.zip --db data/pois.db --max-file-mb 5
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  ID_BASE, hash42, loadTaxonomy, makeResolveCategory, makeBuildTagsJson,
  buildName, ensureExternalSchema, REPO_ROOT, INGEST_DIR, requireFromServer,
} from './lib/common.mjs';
import { rasterizeMultiPolygon } from './lib/geo.mjs';
import { DedupeIndex } from './lib/dedupe.mjs';

// `better-sqlite3` est installé avec le serveur POI, pas à la racine du dépôt.
const Database = requireFromServer('better-sqlite3');

const USAGE = `Usage: node import-atp.mjs --zip <output.zip> --db <db.sqlite> [options]

  --zip <path>         archive output.zip d'un run AllThePlaces (obligatoire)
  --db <path>          base SQLite cible (obligatoire)
  --country <cc>       code pays visé (défaut : fr)
  --max-file-mb <n>    taille max des fichiers sans suffixe pays (défaut : 20)
  --border <path>      GeoJSON du territoire (défaut : public/france-border.json)
  --limit <n>          n'importer que les n premiers candidats (test)
  --enrich             complète les POI OSM existants (téléphone, site, marque)
  --no-dedupe          désactive le dédoublonnage (diagnostic uniquement)
  --dry-run            analyse sans écrire en base
`;

const argv = process.argv.slice(2);
const args = {
  zip: null, db: null, country: 'fr', maxFileMb: 20, border: null,
  limit: 0, enrich: false, dedupe: true, dryRun: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--zip') args.zip = argv[++i];
  else if (a === '--db') args.db = argv[++i];
  else if (a === '--country') args.country = (argv[++i] || 'fr').toLowerCase();
  else if (a === '--max-file-mb') args.maxFileMb = parseFloat(argv[++i]) || 20;
  else if (a === '--border') args.border = argv[++i];
  else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
  else if (a === '--enrich') args.enrich = true;
  else if (a === '--no-dedupe') args.dedupe = false;
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
}
if (!args.zip || !args.db) { console.error(USAGE); process.exit(1); }

const zipPath = path.resolve(args.zip);
if (!fs.existsSync(zipPath)) { console.error(`❌ Archive introuvable : ${zipPath}`); process.exit(1); }
const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) { console.error(`❌ Base introuvable : ${dbPath}`); process.exit(1); }

const { taxonomy, keepTags } = loadTaxonomy();
const resolveCategory = makeResolveCategory(taxonomy);
const buildTagsJson = makeBuildTagsJson(keepTags);

// ── Masque du territoire ──────────────────────────────────────────────

// Le GeoJSON de frontière est cherché à plusieurs emplacements : dans le
// dépôt il vit sous `public/`, mais sur le VPS tout est déployé à plat dans
// /opt/poi-server/ — où `REPO_ROOT` vaudrait `/` et le chemin serait faux.
const borderCandidates = [
  args.border,
  path.join(INGEST_DIR, 'france-border.json'),
  path.join(REPO_ROOT, 'public/france-border.json'),
].filter(Boolean);
const borderPath = borderCandidates.find((c) => fs.existsSync(c));
if (!borderPath) {
  console.error('❌ Frontière introuvable. Chemins essayés :');
  for (const c of borderCandidates) console.error(`   ${c}`);
  process.exit(1);
}
const tMask = Date.now();
const mask = rasterizeMultiPolygon(JSON.parse(fs.readFileSync(borderPath, 'utf8')));
console.log(`🗺️  Masque ${args.country.toUpperCase()} : ${mask.cells.toLocaleString('fr-FR')} cellules (${((Date.now() - tMask) / 1000).toFixed(1)} s)`);

// ── Sélection des fichiers de l'archive ───────────────────────────────

const suffix = `_${args.country}.geojson`;
const entries = [];

/**
 * Lecture ZIP sans dépendance externe et **sans charger l'archive en mémoire** :
 * `output.zip` pèse 2,4 Go. On lit le répertoire central par la fin du fichier,
 * puis chaque entrée à la demande, à son offset.
 */
const zipFd = fs.openSync(zipPath, 'r');
const zipSize = fs.statSync(zipPath).size;

function readAt(offset, length) {
  const b = Buffer.allocUnsafe(length);
  const n = fs.readSync(zipFd, b, 0, length, offset);
  return n === length ? b : b.subarray(0, n);
}

function readZipDirectory() {
  const tailLen = Math.min(zipSize, 66000);
  const tail = readAt(zipSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive ZIP illisible (fin de répertoire central introuvable)');

  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = readAt(cdOffset, cdSize);

  const out = [];
  let off = 0;
  for (let i = 0; i < count && off + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(off) !== 0x02014b50) break;
    const method = cd.readUInt16LE(off + 10);
    const compSize = cd.readUInt32LE(off + 20);
    const nameLen = cd.readUInt16LE(off + 28);
    const extraLen = cd.readUInt16LE(off + 30);
    const commentLen = cd.readUInt16LE(off + 32);
    const localOff = cd.readUInt32LE(off + 42);
    const name = cd.toString('utf8', off + 46, off + 46 + nameLen);

    // Entête local : nécessaire pour localiser les données (nom + extra
    // peuvent différer du répertoire central).
    const lh = readAt(localOff, 30);
    const lNameLen = lh.readUInt16LE(26);
    const lExtraLen = lh.readUInt16LE(28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const lCompSize = lh.readUInt32LE(18);

    out.push({ name, method, compSize: lCompSize || compSize, dataStart, size: compSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readZipEntry(entry) {
  const raw = readAt(entry.dataStart, entry.compSize);
  if (entry.method === 0) return raw.toString('utf8');
  if (entry.method === 8) return zlib.inflateRawSync(raw).toString('utf8');
  throw new Error(`Compression ZIP non supportée (méthode ${entry.method})`);
}

const dir = readZipDirectory().filter((e) => e.name.endsWith('.geojson'));

const frFiles = dir.filter((e) => e.name.endsWith(suffix));
// Marques mondiales : fichiers sans suffixe pays, sous le seuil de taille.
// Au-delà, ce sont des jeux d'adresses, d'arbres ou de poteaux — hors sujet.
const globalFiles = dir.filter((e) => {
  if (e.name.endsWith(suffix)) return false;
  const base = e.name.split('/').pop();
  const cc = base.replace(/\.geojson$/, '').split('_').pop();
  if (cc.length === 2 && cc !== args.country) return false; // autre pays explicite
  return e.compSize <= args.maxFileMb * 1e6;
});

console.log(`📦 Archive : ${dir.length.toLocaleString('fr-FR')} fichiers GeoJSON`);
console.log(`   ${frFiles.length} spécifiques ${args.country.toUpperCase()} + ${globalFiles.length} mondiaux ≤ ${args.maxFileMb} Mo`);
entries.push(...frFiles, ...globalFiles);

// ── Base ──────────────────────────────────────────────────────────────

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -262144');
const added = ensureExternalSchema(db);
if (added.length) console.log(`🔧 Schéma migré : +${added.join(', +')}`);
const before = db.prepare('SELECT count(*) AS n FROM pois').get().n;
console.log(`📊 Base avant : ${before.toLocaleString('fr-FR')} POI`);

let index = null;
if (args.dedupe) {
  index = new DedupeIndex();
  const t0 = Date.now();
  const n = index.buildFromDb(db, {
    onProgress: (d, t) => process.stdout.write(`\r   index spatial : ${d.toLocaleString('fr-FR')}/${t.toLocaleString('fr-FR')}   `),
  });
  console.log(`\r   ✅ index spatial : ${n.toLocaleString('fr-FR')} POI en ${((Date.now() - t0) / 1000).toFixed(0)} s            `);
}

const insPoi = db.prepare(
  'INSERT OR REPLACE INTO pois (id, osm_id, osm_type, lat, lon, category, name, tags, source, src_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
);
const insRtree = db.prepare(
  'INSERT OR REPLACE INTO poi_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
);
const insertTx = db.transaction((rows) => {
  for (const r of rows) {
    insPoi.run(r.id, null, 'atp', r.lat, r.lon, r.category, r.name, r.tags, 'atp', null);
    insRtree.run(r.id, r.lon, r.lon, r.lat, r.lat);
  }
});
const getTags = db.prepare('SELECT tags FROM pois WHERE id = ?');
const setTags = db.prepare('UPDATE pois SET tags = ? WHERE id = ?');
const enrichTx = db.transaction((rows) => {
  for (const { id, patch } of rows) {
    const row = getTags.get(id);
    let tags = {};
    try { tags = row?.tags ? JSON.parse(row.tags) : {}; } catch { tags = {}; }
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || tags[k]) continue;
      tags[k] = v; changed = true;
    }
    if (changed) setTags.run(JSON.stringify(tags), id);
  }
});

const stats = { files: 0, read: 0, outside: 0, unmapped: 0, noName: 0, duplicates: 0, enriched: 0, inserted: 0 };
const perCategory = new Map();
const perSpider = new Map();
const batch = [];
let enrichBatch = [];

const flush = () => {
  if (!batch.length) return;
  if (!args.dryRun) insertTx(batch);
  for (const r of batch) if (index) index.accept(r);
  batch.length = 0;
};

function handleFeature(feat, forced) {
  const p = feat.properties || {};
  const g = feat.geometry || {};
  const co = g.coordinates;

  let lon = null; let lat = null;
  if (Array.isArray(co) && co.length >= 2 && typeof co[0] === 'number' && typeof co[1] === 'number') {
    [lon, lat] = co;
  }
  if (lon === null) return; // sans géométrie, inutilisable comme POI

  const inCountry = forced || p['addr:country'] === args.country.toUpperCase() || mask.contains(lon, lat);
  if (!inCountry) { stats.outside++; return; }

  const category = resolveCategory(p);
  if (!category) { stats.unmapped++; return; }

  const name = buildName(p) || p.brand || null;
  if (!name) { stats.noName++; return; }

  const ref = p.ref || feat.id || `${p['@spider']}:${lat},${lon}`;
  const candidate = {
    id: ID_BASE.atp + hash42(String(ref)),
    lat, lon, category, name,
    tags: p,
  };

  if (index) {
    const match = index.findMatch(candidate);
    if (match) {
      stats.duplicates++;
      if (args.enrich && !args.dryRun && match.id < 10_000_000_000_000) {
        const patch = {};
        if (p.phone) patch.phone = p.phone;
        if (p.website) patch.website = p.website;
        if (p.brand) patch.brand = p.brand;
        if (p.opening_hours) patch.opening_hours = p.opening_hours;
        if (Object.keys(patch).length) {
          enrichBatch.push({ id: match.id, patch });
          if (enrichBatch.length >= 5000) { enrichTx(enrichBatch); stats.enriched += enrichBatch.length; enrichBatch = []; }
        }
      }
      return;
    }
  }

  candidate.tags = buildTagsJson(p);
  batch.push(candidate);
  perCategory.set(category, (perCategory.get(category) || 0) + 1);
  const sp = p['@spider'] || '?';
  perSpider.set(sp, (perSpider.get(sp) || 0) + 1);
  stats.inserted++;
  if (batch.length >= 5000) flush();
}

const t0 = Date.now();
for (const entry of entries) {
  if (args.limit && stats.inserted + stats.duplicates >= args.limit) break;
  stats.files++;
  const forced = entry.name.endsWith(suffix);
  let raw;
  try {
    raw = readZipEntry(entry);
  } catch (err) {
    console.warn(`\n   ⚠️  ${entry.name} illisible : ${err.message}`);
    continue;
  }

  try {
    const data = JSON.parse(raw);
    for (const f of data.features || []) { stats.read++; handleFeature(f, forced); }
  } catch {
    // Fichier tronqué ou NDJSON : repli ligne à ligne.
    let ok = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim().replace(/,$/, '');
      if (!s.startsWith('{')) continue;
      try {
        const o = JSON.parse(s);
        if (o.type === 'Feature') { stats.read++; handleFeature(o, forced); ok++; }
      } catch { /* ligne coupée en fin de fichier */ }
    }
    if (ok === 0) console.warn(`\n   ⚠️  ${entry.name} non exploitable`);
  }

  if (stats.files % 200 === 0) {
    process.stdout.write(`\r   ${stats.files}/${entries.length} fichiers — lus ${stats.read.toLocaleString('fr-FR')} — insérés ${stats.inserted.toLocaleString('fr-FR')} (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
  }
}
flush();
if (enrichBatch.length) { enrichTx(enrichBatch); stats.enriched += enrichBatch.length; }

console.log(`\r   ✅ ${stats.files} fichiers, ${stats.read.toLocaleString('fr-FR')} lieux lus en ${((Date.now() - t0) / 1000).toFixed(0)} s            `);

console.log('\n── Résultat ──');
console.log(`   hors ${args.country.toUpperCase()}                        : ${stats.outside.toLocaleString('fr-FR')}`);
console.log(`   hors des 46 catégories            : ${stats.unmapped.toLocaleString('fr-FR')}`);
console.log(`   sans nom                          : ${stats.noName.toLocaleString('fr-FR')}`);
console.log(`   doublons écartés                  : ${stats.duplicates.toLocaleString('fr-FR')}`);
if (index) {
  console.log('   règles déclenchées :');
  for (const line of index.report()) console.log(line);
}
console.log(`   enrichissements OSM               : ${stats.enriched.toLocaleString('fr-FR')}`);
console.log(`   ✅ POI insérés                    : ${stats.inserted.toLocaleString('fr-FR')}`);

if (perCategory.size) {
  console.log('\n── Par catégorie ──');
  for (const [cat, n] of [...perCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(8)}  ${cat}`);
  }
  console.log('\n── Top 15 spiders ──');
  for (const [sp, n] of [...perSpider.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${String(n).padStart(8)}  ${sp}`);
  }
}

if (args.dryRun) {
  console.log('\n🔍 --dry-run : rien n\'a été écrit en base.');
} else {
  db.exec('ANALYZE; PRAGMA optimize;');
  const after = db.prepare('SELECT count(*) AS n FROM pois').get().n;
  console.log(`\n📊 Base après : ${after.toLocaleString('fr-FR')} POI (+${(after - before).toLocaleString('fr-FR')})`);
  console.log(`\n➡️  Pour basculer le service : ./swap-db.sh ${dbPath}`);
}
db.close();
