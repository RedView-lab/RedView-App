#!/usr/bin/env node
/**
 * RedView — import des POI **Overture Maps** (thème `places`).
 *
 * Overture est la source externe la plus rentable : 2 164 599 lieux en France
 * (mesuré sur la release 2026-08-19.0), dont 493 449 tombent dans nos 46
 * catégories au seuil de confiance 0,5. Elle agrège déjà Meta (1,78 M de lieux
 * FR), Microsoft, Foursquare (288 681) et AllThePlaces (79 056) — d'où l'ordre
 * d'ingestion : **Overture d'abord**, les autres sources en complément.
 *
 * Deux principes :
 *
 *   1. **Aucun téléchargement massif.** DuckDB lit les Parquet directement sur
 *      S3 et ne rapatrie que les colonnes utiles, filtrées sur `country = 'FR'`.
 *      Le thème `places` mondial pèse plusieurs dizaines de Go ; l'extrait
 *      France en NDJSON tient en quelques centaines de Mo.
 *   2. **OSM reste canonique.** Un lieu Overture qui correspond à un POI
 *      existant est *écarté* — sauf pour enrichir le POI OSM d'un téléphone,
 *      d'un site web ou d'une marque qu'il n'avait pas. Aucun tag OSM n'est
 *      jamais écrasé.
 *
 * Usage :
 *   node import-overture.mjs --db data/pois.db
 *   node import-overture.mjs --db data/pois.db --dry-run
 *   node import-overture.mjs --db data/pois.db --reuse /tmp/overture-fr.ndjson
 *   node import-overture.mjs --db data/pois.db --confidence 0.7 --limit 50000
 *
 * Prérequis : binaire DuckDB (voir l'aide affichée s'il est absent).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  ID_BASE, hash42, loadTaxonomy, makeBuildTagsJson, ensureExternalSchema,
  runDuckDb, latestOvertureRelease, DUCKDB_INSTALL_HINT, resolveDuckDb,
  requireFromServer,
} from './lib/common.mjs';
import { overtureCategory, OVERTURE_MAPPED_KEYS } from './lib/mappings.mjs';
import { DedupeIndex } from './lib/dedupe.mjs';

// `better-sqlite3` est installé avec le serveur POI, pas à la racine du dépôt.
const Database = requireFromServer('better-sqlite3');

const USAGE = `Usage: node import-overture.mjs --db <db.sqlite> [options]

  --db <path>          base SQLite cible (obligatoire)
  --release <id>       release Overture (défaut : dernière, lue sur le STAC)
  --confidence <n>     seuil de confiance minimum (défaut : 0.5)
  --extract <path>     fichier NDJSON intermédiaire (défaut : ./data/overture-fr.ndjson)
  --reuse              réutilise l'extrait s'il existe (évite de relire S3)
  --limit <n>          n'importer que les n premiers candidats (test)
  --duckdb <path>      binaire DuckDB explicite
  --enrich             complète les POI OSM existants (téléphone, site, marque)
  --no-dedupe          désactive le dédoublonnage (diagnostic uniquement)
  --dry-run            analyse sans écrire en base
`;

const argv = process.argv.slice(2);
const args = {
  db: null, release: null, confidence: 0.5, extract: null, reuse: false,
  limit: 0, duckdb: null, enrich: false, dedupe: true, dryRun: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') args.db = argv[++i];
  else if (a === '--release') args.release = argv[++i];
  else if (a === '--confidence') args.confidence = parseFloat(argv[++i]);
  else if (a === '--extract') args.extract = argv[++i];
  else if (a === '--reuse') args.reuse = true;
  else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
  else if (a === '--duckdb') args.duckdb = argv[++i];
  else if (a === '--enrich') args.enrich = true;
  else if (a === '--no-dedupe') args.dedupe = false;
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
}
if (!args.db) { console.error(USAGE); process.exit(1); }

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) {
  console.error(`❌ Base introuvable : ${dbPath}`);
  process.exit(1);
}
if (!Number.isFinite(args.confidence)) args.confidence = 0.5;

const { taxonomy, keepTags } = loadTaxonomy();
const buildTagsJson = makeBuildTagsJson(keepTags);

// ── Étape 1 : extraction France ───────────────────────────────────────

const extractPath = path.resolve(
  args.extract || path.resolve(path.dirname(dbPath), 'overture-fr.ndjson'),
);

async function extract() {
  const release = args.release || await latestOvertureRelease();
  console.log(`📦 Overture release : ${release}`);
  const src = `s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*`;

  if (args.reuse && fs.existsSync(extractPath)) {
    console.log(`⏭️  Extrait réutilisé : ${extractPath} (${(fs.statSync(extractPath).size / 1e6).toFixed(0)} Mo)`);
    return extractPath;
  }
  if (!resolveDuckDb(args.duckdb)) { console.error(DUCKDB_INSTALL_HINT); process.exit(1); }

  fs.mkdirSync(path.dirname(extractPath), { recursive: true });
  if (fs.existsSync(extractPath)) fs.rmSync(extractPath);

  console.log('⬇️  Extraction France via DuckDB (lecture directe sur S3, pas de téléchargement du thème)…');
  const t0 = Date.now();
  runDuckDb(`
    INSTALL httpfs; LOAD httpfs;
    INSTALL spatial; LOAD spatial;
    SET s3_region='us-west-2';
    SET enable_progress_bar=true;
    COPY (
      SELECT
        id                                AS gers_id,
        names.primary                     AS name,
        brand.names.primary               AS brand,
        taxonomy.primary                  AS tax_primary,
        basic_category                    AS basic_category,
        confidence,
        operating_status,
        addresses[1].freeform             AS street,
        addresses[1].locality             AS city,
        addresses[1].postcode             AS postcode,
        websites[1]                       AS website,
        phones[1]                         AS phone,
        emails[1]                         AS email,
        ST_X(geometry)                    AS lon,
        ST_Y(geometry)                    AS lat
      FROM read_parquet('${src}')
      WHERE addresses[1].country = 'FR'
    ) TO '${extractPath.replace(/\\/g, '/')}' (FORMAT JSON, ARRAY false);
  `, { duckdb: args.duckdb });
  const size = fs.statSync(extractPath).size;
  console.log(`✅ Extrait France : ${(size / 1e6).toFixed(0)} Mo en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return extractPath;
}

// ── Étape 2 : fusion ──────────────────────────────────────────────────

function openDb() {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -262144');
  return db;
}

async function main() {
  const file = await extract();

  // Garde-fou : DuckDB doit produire du NDJSON, pas un tableau JSON.
  // Lecture de 64 octets seulement — le fichier peut peser plusieurs centaines de Mo.
  const fd = fs.openSync(file, 'r');
  const headBuf = Buffer.alloc(64);
  const read = fs.readSync(fd, headBuf, 0, 64, 0);
  fs.closeSync(fd);
  const head = headBuf.subarray(0, read).toString('utf8').trimStart();
  if (head.startsWith('[')) {
    console.error('❌ L\'extrait est un tableau JSON, pas du NDJSON. Supprimer le fichier et relancer');
    console.error('   (option `ARRAY false` non honorée par cette version de DuckDB).');
    process.exit(1);
  }

  const db = openDb();
  const added = ensureExternalSchema(db);
  if (added.length) console.log(`🔧 Schéma migré : +${added.join(', +')}`);

  const before = db.prepare('SELECT count(*) AS n FROM pois').get().n;
  console.log(`📊 Base avant : ${before.toLocaleString('fr-FR')} POI`);

  let index = null;
  if (args.dedupe) {
    index = new DedupeIndex();
    const t0 = Date.now();
    const n = index.buildFromDb(db, {
      onProgress: (done, total) => process.stdout.write(`\r   index spatial : ${done.toLocaleString('fr-FR')}/${total.toLocaleString('fr-FR')}   `),
    });
    console.log(`\r   ✅ index spatial : ${n.toLocaleString('fr-FR')} POI en ${((Date.now() - t0) / 1000).toFixed(0)} s            `);
  } else {
    console.log('⚠️  Dédoublonnage désactivé (--no-dedupe) : diagnostic uniquement.');
  }

  const insPoi = db.prepare(
    'INSERT OR REPLACE INTO pois (id, osm_id, osm_type, lat, lon, category, name, tags, source, src_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insRtree = db.prepare(
    'INSERT OR REPLACE INTO poi_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
  );
  const insertTx = db.transaction((rows) => {
    for (const r of rows) {
      insPoi.run(r.id, r.osmId, 'overture', r.lat, r.lon, r.category, r.name, r.tags, 'overture', r.confidence);
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
        tags[k] = v;
        changed = true;
      }
      if (changed) setTags.run(JSON.stringify(tags), id);
    }
  });

  const stats = {
    read: 0, noName: 0, lowConfidence: 0, unmapped: 0,
    duplicates: 0, enriched: 0, inserted: 0,
  };
  const perCategory = new Map();
  const batch = [];
  const enrichBatch = [];

  // En dry-run on ne touche pas à la base, mais on alimente quand même l'index
  // avec les candidats acceptés : sinon le comptage des doublons serait faussé,
  // les POI déjà acceptés n'étant pas revus par les candidats suivants.
  const flush = () => {
    if (!batch.length) return;
    if (!args.dryRun) insertTx(batch);
    for (const r of batch) if (index) index.accept(r);
    batch.length = 0;
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const t0 = Date.now();
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    stats.read++;

    if (args.limit && stats.inserted + stats.duplicates >= args.limit) break;

    const conf = typeof o.confidence === 'number' ? o.confidence : null;
    if (conf === null || conf < args.confidence) { stats.lowConfidence++; continue; }

    const category = overtureCategory(o.tax_primary, o.basic_category);
    if (!category) { stats.unmapped++; continue; }

    const name = o.name || o.brand || null;
    if (!name) { stats.noName++; continue; }

    const candidate = {
      id: ID_BASE.overture + hash42(String(o.gers_id)),
      osmId: null,
      lat: o.lat,
      lon: o.lon,
      category,
      name,
      confidence: conf,
      tags: {
        brand: o.brand,
        website: o.website,
        phone: o.phone,
        email: o.email,
        'addr:street': o.street,
        'addr:city': o.city,
        'addr:postcode': o.postcode,
        ref: String(o.gers_id),
      },
    };

    if (index) {
      const match = index.findMatch(candidate);
      if (match) {
        stats.duplicates++;
        // Enrichissement : uniquement sur un POI OSM (id < 1e13), jamais
        // l'inverse — OSM reste la source canonique.
        if (args.enrich && !args.dryRun && match.id < 10_000_000_000_000) {
          const patch = {};
          if (o.phone) patch.phone = o.phone;
          if (o.website) patch.website = o.website;
          if (o.brand) patch.brand = o.brand;
          if (Object.keys(patch).length) {
            enrichBatch.push({ id: match.id, patch });
            if (enrichBatch.length >= 5000) { enrichTx(enrichBatch); stats.enriched += enrichBatch.length; enrichBatch.length = 0; }
          }
        }
        continue;
      }
    }

    candidate.tags = buildTagsJson(candidate.tags);
    batch.push(candidate);
    perCategory.set(category, (perCategory.get(category) || 0) + 1);
    stats.inserted++;
    if (batch.length >= 5000) flush();

    if (stats.read % 100000 === 0) {
      process.stdout.write(`\r   lus ${stats.read.toLocaleString('fr-FR')} — insérés ${stats.inserted.toLocaleString('fr-FR')} — doublons ${stats.duplicates.toLocaleString('fr-FR')} (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
    }
  }
  flush();
  if (enrichBatch.length) { enrichTx(enrichBatch); stats.enriched += enrichBatch.length; }

  console.log(`\r   ✅ ${stats.read.toLocaleString('fr-FR')} lignes lues en ${((Date.now() - t0) / 1000).toFixed(0)} s            `);

  console.log('\n── Résultat ──');
  console.log(`   retenus (conf ≥ ${args.confidence}) : ${(stats.read - stats.lowConfidence).toLocaleString('fr-FR')}`);
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
  }

  if (args.dryRun) {
    console.log('\n🔍 --dry-run : rien n\'a été écrit en base.');
  } else {
    db.exec('ANALYZE; PRAGMA optimize;');
    const after = db.prepare('SELECT count(*) AS n FROM pois').get().n;
    const bySource = db.prepare('SELECT coalesce(source, \'osm\') AS s, count(*) AS n FROM pois GROUP BY 1 ORDER BY 2 DESC').all();
    console.log(`\n📊 Base après : ${after.toLocaleString('fr-FR')} POI (+${(after - before).toLocaleString('fr-FR')})`);
    for (const r of bySource) console.log(`   ${String(r.n).padStart(10)}  ${r.s}`);
  }
  db.close();

  if (!args.dryRun) {
    console.log(`\n➡️  Pour basculer le service : ./swap-db.sh ${dbPath}`);
  }
}

main().catch((err) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
