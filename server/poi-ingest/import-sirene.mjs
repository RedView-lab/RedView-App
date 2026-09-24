#!/usr/bin/env node
/**
 * RedView — import des POI **SIRENE géocodée** (INSEE).
 *
 * C'est la source la plus volumineuse et la plus piégeuse des quatre. Trois
 * obstacles, tous traités ici :
 *
 *   1. **Le fichier géocodé ne contient ni nom ni catégorie.** Il ne porte que
 *      `siret`, `x`, `y` et des zonages (37 901 783 lignes). Il faut donc le
 *      joindre au `StockEtablissement` (44 064 115 lignes) pour récupérer
 *      `activitePrincipaleEtablissement` et l'enseigne.
 *
 *   2. **Un registre d'entreprises n'est pas une base POI.** Le NAF `55.20Z`
 *      (« hébergement touristique et autre hébergement de courte durée »,
 *      137 750 établissements) désigne très majoritairement des meublés de
 *      tourisme déclarés en mairie, pas des hôtels. Il est exclu de la table de
 *      correspondance : l'inclure ferait exploser `hotel` d'un facteur 4 avec
 *      des adresses résidentielles.
 *
 *   3. **Les adresses partagées.** Les 200 140 « médecins » exercent souvent à
 *      plusieurs à la même adresse (cabinets de groupe, maisons de santé). Le
 *      géocodage renvoie alors exactement le même point des dizaines de fois.
 *      On regroupe par (catégorie, position arrondie à ~10 m) et on ne garde
 *      qu'un POI par groupe.
 *
 * SIRENE n'a **aucune donnée d'horaires d'ouverture** : ces POI sont des
 * points de repère, pas des étapes planifiables.
 *
 * Usage :
 *   node import-sirene.mjs --db data/pois.db
 *   node import-sirene.mjs --db data/pois.db --geoloc data/sirene/geoloc.parquet --dry-run
 *   node import-sirene.mjs --db data/pois.db --reuse /tmp/sirene.ndjson
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  ID_BASE, loadTaxonomy, makeBuildTagsJson, ensureExternalSchema,
  runDuckDb, DUCKDB_INSTALL_HINT, resolveDuckDb, requireFromServer,
} from './lib/common.mjs';
import { sireneCategory, SIRENE_NAF_CODES, SIRENE_EXCLUDED_DEFAULT } from './lib/mappings.mjs';
import { DedupeIndex } from './lib/dedupe.mjs';

// `better-sqlite3` est installé avec le serveur POI, pas à la racine du dépôt.
const Database = requireFromServer('better-sqlite3');

const GEOLOC_URL = 'https://static.data.gouv.fr/resources/geolocalisation-des-etablissements-du-repertoire-sirene-pour-les-etudes-statistiques/20260921-065930/geoloc-geolocalisationetablissement-sirene-pour-etudes-statistiques-parquet.parquet';
const STOCK_URL = 'https://static.data.gouv.fr/resources/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret/20260901-090503/stock-stocketablissement-parquet.parquet';
const UL_URL = 'https://static.data.gouv.fr/resources/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret/20260901-084858/stock-stockunitelegale-parquet.parquet';

const USAGE = `Usage: node import-sirene.mjs --db <db.sqlite> [options]

  --db <path>          base SQLite cible (obligatoire)
  --geoloc <path|url>  parquet de géolocalisation INSEE (défaut : URL data.gouv)
  --stock <path|url>   parquet StockEtablissement (défaut : URL data.gouv)
  --unite-legale <path|url>  parquet StockUniteLegale (défaut : URL data.gouv)
  --no-unite-legale    désactive la récupération des noms d'exploitants
  --extract <path>     NDJSON intermédiaire (défaut : <db_dir>/sirene.ndjson)
  --reuse              réutilise l'extrait s'il existe
  --duckdb <path>      binaire DuckDB explicite
  --limit <n>          n'importer que les n premiers candidats (test)
  --enrich             complète les POI OSM existants
  --exclude-categories <clés>  catégories à écarter (défaut : ${SIRENE_EXCLUDED_DEFAULT.join(',')})
  --include-categories <clés>  n'écarter que celles-ci (remplace le défaut)
  --no-dedupe          désactive le dédoublonnage (diagnostic uniquement)
  --dry-run            analyse sans écrire en base

Note : le fichier géolocalisé est volumineux (810 Mo). StockEtablissement
(2,2 Go) et StockUniteLegale (708 Mo) sont lus à distance par DuckDB —
inutile de les télécharger.`;

const argv = process.argv.slice(2);
const args = {
  db: null, geoloc: GEOLOC_URL, stock: STOCK_URL, uniteLegale: UL_URL,
  extract: null, reuse: false, duckdb: null, limit: 0, enrich: false,
  dedupe: true, dryRun: false, excluded: null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--db') args.db = argv[++i];
  else if (a === '--geoloc') args.geoloc = argv[++i];
  else if (a === '--stock') args.stock = argv[++i];
  else if (a === '--unite-legale') args.uniteLegale = argv[++i];
  else if (a === '--no-unite-legale') args.uniteLegale = null;
  else if (a === '--extract') args.extract = argv[++i];
  else if (a === '--reuse') args.reuse = true;
  else if (a === '--duckdb') args.duckdb = argv[++i];
  else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || 0;
  else if (a === '--enrich') args.enrich = true;
  else if (a === '--exclude-categories') args.excluded = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--include-categories') args.excluded = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--no-dedupe') args.dedupe = false;
  else if (a === '--dry-run') args.dryRun = true;
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
}

/**
 * Catégories écartées. Par défaut : celles dont la définition NAF diverge trop
 * de l'étiquette OSM (voir SIRENE_EXCLUDED_DEFAULT). `--include-categories`
 * remplace ce défaut, `--exclude-categories` le redéfinit.
 */
const EXCLUDED = new Set(
  args.excluded !== null ? args.excluded : SIRENE_EXCLUDED_DEFAULT,
);
if (!args.db) { console.error(USAGE); process.exit(1); }

const dbPath = path.resolve(args.db);
if (!fs.existsSync(dbPath)) { console.error(`❌ Base introuvable : ${dbPath}`); process.exit(1); }

const { taxonomy, keepTags } = loadTaxonomy();
const buildTagsJson = makeBuildTagsJson(keepTags);
const CATEGORY_LABEL = Object.fromEntries(taxonomy.categories.map((c) => [c.key, c.label]));

/** DuckDB accepte une URL telle quelle ; un chemin doit exister localement. */
function sourceRef(value, label) {
  if (/^https?:\/\//i.test(value)) return `'${value}'`;
  const p = path.resolve(value);
  if (!fs.existsSync(p)) {
    console.error(`❌ ${label} introuvable : ${p}`);
    process.exit(1);
  }
  return `'${p.replace(/\\/g, '/')}'`;
}

const extractPath = path.resolve(
  args.extract || path.resolve(path.dirname(dbPath), 'sirene.ndjson'),
);

// ── Étape 1 : jointure géoloc × StockEtablissement ────────────────────

function extract() {
  if (args.reuse && fs.existsSync(extractPath)) {
    console.log(`⏭️  Extrait réutilisé : ${extractPath} (${(fs.statSync(extractPath).size / 1e6).toFixed(0)} Mo)`);
    return;
  }
  if (!resolveDuckDb(args.duckdb)) { console.error(DUCKDB_INSTALL_HINT); process.exit(1); }

  fs.mkdirSync(path.dirname(extractPath), { recursive: true });
  if (fs.existsSync(extractPath)) fs.rmSync(extractPath);

  const nafList = SIRENE_NAF_CODES.map((c) => `'${c}'`).join(', ');

  // Jointure StockUniteLegale : 59 % des établissements n'ont ni enseigne ni
  // dénomination, et seulement 3 % des médecins généralistes ont une enseigne.
  // L'unité légale porte le nom de l'exploitant individuel, ce qui rend ces
  // POI exploitables et permet à la déduplication par nom de fonctionner.
  const ulCte = args.uniteLegale ? `
      , ul AS (
        SELECT siren,
          nullif(coalesce(nullif(trim(denominationUsuelle1UniteLegale),''),
                          nullif(trim(denominationUniteLegale),''),
                          nullif(trim(sigleUniteLegale),'')), '') AS nom_societe,
          nullif(trim(coalesce(nullif(trim(prenomUsuelUniteLegale),''),
                               nullif(trim(prenom1UniteLegale),''), '')
                      || ' ' ||
                      coalesce(nullif(trim(nomUsageUniteLegale),''),
                               nullif(trim(nomUniteLegale),''), '')), '') AS nom_personne
        FROM read_parquet(${sourceRef(args.uniteLegale, 'StockUniteLegale')})
        WHERE etatAdministratifUniteLegale = 'A'
      )` : '';
  const ulJoin = args.uniteLegale ? 'LEFT JOIN ul u ON u.siren = substr(s.siret, 1, 9)' : '';
  const ulCols = args.uniteLegale
    ? 'u.nom_societe, u.nom_personne,'
    : 'NULL AS nom_societe, NULL AS nom_personne,';

  console.log(`⬇️  Jointure SIRENE (${SIRENE_NAF_CODES.length} codes NAF retenus)…`);
  console.log('   StockEtablissement lu à distance, colonnes utiles uniquement.');
  console.log(args.uniteLegale
    ? '   StockUniteLegale joint pour récupérer les noms d\'exploitants.'
    : '   ⚠️  StockUniteLegale désactivé : les entrées sans enseigne resteront anonymes.');

  const t0 = Date.now();
  runDuckDb(`
    INSTALL httpfs; LOAD httpfs;
    SET enable_progress_bar=true;
    COPY (
      WITH stock AS (
        SELECT siret,
               activitePrincipaleEtablissement        AS naf,
               enseigne1Etablissement                 AS enseigne,
               denominationUsuelleEtablissement       AS denomination,
               numeroVoieEtablissement                AS num,
               typeVoieEtablissement                  AS typevoie,
               libelleVoieEtablissement               AS voie,
               codePostalEtablissement                AS cp,
               libelleCommuneEtablissement            AS ville,
               trancheEffectifsEtablissement          AS effectif
        FROM read_parquet(${sourceRef(args.stock, 'StockEtablissement')})
        WHERE etatAdministratifEtablissement = 'A'
          AND activitePrincipaleEtablissement IN (${nafList})
      )${ulCte}
      SELECT s.naf, g.siret, s.enseigne, s.denomination,
             ${ulCols}
             s.num, s.typevoie, s.voie, s.cp, s.ville, s.effectif,
             g.y_latitude AS lat, g.x_longitude AS lon
      FROM read_parquet(${sourceRef(args.geoloc, 'Géolocalisation')}) g
      JOIN stock s ON s.siret = g.siret
      ${ulJoin}
      WHERE g.y_latitude IS NOT NULL AND g.x_longitude IS NOT NULL
    ) TO '${extractPath.replace(/\\/g, '/')}' (FORMAT JSON, ARRAY false);
  `, { duckdb: args.duckdb });

  console.log(`✅ Extrait SIRENE : ${(fs.statSync(extractPath).size / 1e6).toFixed(0)} Mo en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// ── Étape 2 : fusion ──────────────────────────────────────────────────

/**
 * Construit le libellé du POI, par ordre de qualité décroissante.
 *
 * Les deux premiers champs viennent de l'établissement, les deux suivants de
 * l'unité légale (jointure StockUniteLegale) — c'est ce qui nomme les
 * 471 913 établissements sans enseigne, dont 97 % des cabinets médicaux.
 */
function buildName(o, category) {
  const real = o.enseigne || o.denomination || o.nom_societe || o.nom_personne;
  if (real) return String(real).trim().replace(/\s+/g, ' ');
  // Dernier recours : libellé de catégorie + adresse. Un nom générique
  // (« Médecin ») provoquerait des fusions abusives via la règle de nom ;
  // l'adresse rend le libellé unique et reste lisible dans l'interface.
  const label = CATEGORY_LABEL[category] || category;
  const addr = [o.num, o.typevoie, o.voie].filter(Boolean).join(' ').trim();
  return addr ? `${label} — ${addr}` : label;
}

/** Origine du nom retenu, pour mesurer l'apport de StockUniteLegale. */
function nameOrigin(o) {
  if (o.enseigne) return 'enseigne';
  if (o.denomination) return 'denomination';
  if (o.nom_societe) return 'unite-legale (societe)';
  if (o.nom_personne) return 'unite-legale (personne)';
  return 'repli (categorie + adresse)';
}

async function main() {
  extract();

  const fd0 = fs.openSync(extractPath, 'r');
  const headBuf = Buffer.alloc(64);
  const n = fs.readSync(fd0, headBuf, 0, 64, 0);
  fs.closeSync(fd0);
  if (headBuf.subarray(0, n).toString('utf8').trimStart().startsWith('[')) {
    console.error('❌ L\'extrait est un tableau JSON, pas du NDJSON. Supprimer le fichier et relancer.');
    process.exit(1);
  }

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
    const cnt = index.buildFromDb(db, {
      onProgress: (d, t) => process.stdout.write(`\r   index spatial : ${d.toLocaleString('fr-FR')}/${t.toLocaleString('fr-FR')}   `),
    });
    console.log(`\r   ✅ index spatial : ${cnt.toLocaleString('fr-FR')} POI en ${((Date.now() - t0) / 1000).toFixed(0)} s            `);
  }

  const insPoi = db.prepare(
    'INSERT OR REPLACE INTO pois (id, osm_id, osm_type, lat, lon, category, name, tags, source, src_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insRtree = db.prepare(
    'INSERT OR REPLACE INTO poi_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)',
  );
  const insertTx = db.transaction((rows) => {
    for (const r of rows) {
      insPoi.run(r.id, null, 'sirene', r.lat, r.lon, r.category, r.name, r.tags, 'sirene', null);
      insRtree.run(r.id, r.lon, r.lon, r.lat, r.lat);
    }
  });

  const stats = {
    read: 0, unmapped: 0, excluded: 0, noCoords: 0, collapsed: 0,
    duplicates: 0, enriched: 0, inserted: 0,
  };
  const perCategory = new Map();
  const perNaf = new Map();
  const perOrigin = new Map();
  // Regroupement par (catégorie, position arrondie à ~10 m) : les cabinets
  // partagés produisent sinon des dizaines de points superposés.
  const addressSeen = new Set();
  const batch = [];

  const flush = () => {
    if (!batch.length) return;
    if (!args.dryRun) insertTx(batch);
    for (const r of batch) if (index) index.accept(r);
    batch.length = 0;
  };

  const rl = readline.createInterface({ input: fs.createReadStream(extractPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const t0 = Date.now();

  for await (const line of rl) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    stats.read++;
    if (args.limit && stats.inserted + stats.duplicates >= args.limit) break;

    const category = sireneCategory(o.naf);
    if (!category) { stats.unmapped++; continue; }
    if (EXCLUDED.has(category)) { stats.excluded++; continue; }

    const lat = o.lat;
    const lon = o.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { stats.noCoords++; continue; }

    const addrKey = `${category}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
    if (addressSeen.has(addrKey)) { stats.collapsed++; continue; }
    addressSeen.add(addrKey);

    const siret = String(o.siret || '');
    if (!/^\d{14}$/.test(siret)) continue;

    const origin = nameOrigin(o);
    perOrigin.set(origin, (perOrigin.get(origin) || 0) + 1);

    const candidate = {
      id: ID_BASE.sirene + Number(siret),
      lat, lon, category,
      name: buildName(o, category),
      tags: {
        'addr:housenumber': o.num || null,
        'addr:street': [o.typevoie, o.voie].filter(Boolean).join(' ') || null,
        'addr:postcode': o.cp || null,
        'addr:city': o.ville || null,
        ref: siret,
      },
    };

    if (index) {
      const match = index.findMatch(candidate);
      if (match) { stats.duplicates++; continue; }
    }

    candidate.tags = buildTagsJson(candidate.tags);
    batch.push(candidate);
    perCategory.set(category, (perCategory.get(category) || 0) + 1);
    perNaf.set(o.naf, (perNaf.get(o.naf) || 0) + 1);
    stats.inserted++;
    if (batch.length >= 5000) flush();

    if (stats.read % 200000 === 0) {
      process.stdout.write(`\r   lus ${stats.read.toLocaleString('fr-FR')} — insérés ${stats.inserted.toLocaleString('fr-FR')} — regroupés ${stats.collapsed.toLocaleString('fr-FR')} (${((Date.now() - t0) / 1000).toFixed(0)} s)   `);
    }
  }
  flush();

  console.log(`\r   ✅ ${stats.read.toLocaleString('fr-FR')} établissements lus en ${((Date.now() - t0) / 1000).toFixed(0)} s            `);
  console.log('\n── Résultat ──');
  console.log(`   hors des 46 catégories            : ${stats.unmapped.toLocaleString('fr-FR')}`);
  if (EXCLUDED.size) {
    console.log(`   écartés (définition NAF divergente) : ${stats.excluded.toLocaleString('fr-FR')}  [${[...EXCLUDED].join(', ')}]`);
  }
  console.log(`   sans coordonnées                  : ${stats.noCoords.toLocaleString('fr-FR')}`);
  console.log(`   regroupés (adresse partagée)      : ${stats.collapsed.toLocaleString('fr-FR')}`);
  console.log(`   doublons écartés                  : ${stats.duplicates.toLocaleString('fr-FR')}`);
  if (index) {
    console.log('   règles déclenchées :');
    for (const line of index.report()) console.log(line);
  }
  console.log(`   ✅ POI insérés                    : ${stats.inserted.toLocaleString('fr-FR')}`);

  if (perOrigin.size) {
    console.log('\n── Origine des libellés ──');
    for (const [o, v] of [...perOrigin.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(v).padStart(8)}  ${o}`);
    }
  }

  if (perCategory.size) {
    console.log('\n── Par catégorie ──');
    for (const [cat, v] of [...perCategory.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(v).padStart(8)}  ${cat}`);
    }
    console.log('\n── Top 15 codes NAF ──');
    for (const [naf, v] of [...perNaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`   ${String(v).padStart(8)}  ${naf}`);
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
}

main().catch((err) => {
  console.error('\n❌', err.message);
  process.exit(1);
});
