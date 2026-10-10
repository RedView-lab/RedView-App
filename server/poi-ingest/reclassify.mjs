#!/usr/bin/env node
/**
 * RedView — reclassement des POI OSM d'une base existante après un changement
 * de taxonomie, sans relire le PBF.
 *
 * Chaque ligne OSM (`source IS NULL`) est reclassée d'après les tags gardés en
 * base. Ces tags ne sont qu'une partie des tags OSM (`keepTags` de la version
 * qui a écrit la ligne, pas forcément l'actuelle) : une règle qui lit une clé
 * jetée ne peut pas être réévaluée. Deux gardes, sinon la ligne est laissée
 * telle quelle et comptée « non évaluable » :
 *   - les tags en base doivent encore EXPLIQUER la catégorie actuelle (une
 *     règle dont toutes les conditions positives y sont) — un cimetière
 *     importé sans `landuse` (keepTags v3) n'est pas « plus un cimetière » ;
 *   - la nouvelle catégorie ne doit lire que des clés gardées aujourd'hui.
 *
 * Pourquoi pas une réimportation : les sources externes (Overture,
 * AllThePlaces) ont enrichi des POI OSM (téléphone, site, marque) ; les
 * supprimer pour les réimporter perdrait cet enrichissement.
 *
 * Les catégories que la nouvelle taxonomie ajoute à des objets jamais
 * importés (p. ex. un nouveau type de distributeur) demandent, elles, un
 * import ciblé : `import-osm.mjs --append --categories …`.
 *
 * Usage :
 *   node reclassify.mjs --db data/pois.new.db --dry-run
 *   node reclassify.mjs --db data/pois.new.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { makeResolveCategory, ruleMatches } from './lib/taxonomy-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = { db: null, taxonomy: null, dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--db') args.db = argv[++i];
  else if (argv[i] === '--taxonomy') args.taxonomy = argv[++i];
  else if (argv[i] === '--dry-run') args.dryRun = true;
}
if (!args.db || !fs.existsSync(args.db)) {
  console.error('Usage: node reclassify.mjs --db <db.sqlite> [--taxonomy <json>] [--dry-run]');
  process.exit(1);
}

const taxonomy = JSON.parse(fs.readFileSync(args.taxonomy || path.resolve(__dirname, 'poi-taxonomy.json'), 'utf8'));
const keep = new Set([...(taxonomy.keepTags || []), 'name']);
const resolveCategory = makeResolveCategory(taxonomy);

/** Les tags expliquent `category` : une de ses règles a toutes ses conditions positives présentes. */
const rulesByKey = new Map(taxonomy.categories.map((c) => [c.key, c.rules]));
function explains(tags, category) {
  return (rulesByKey.get(category) ?? []).some((rule) => rule.every((cond) => (
    Array.isArray(cond.notIn) || ruleMatches(tags, [cond])
  )));
}

/** Catégorie dont toutes les règles ne lisent que des clés gardées en base. */
const evaluable = new Map(taxonomy.categories.map((c) => [
  c.key,
  c.rules.every((rule) => rule.every((cond) => keep.has(cond.k))),
]));
console.log(`📚 Taxonomie v${taxonomy.version} — non évaluables sur les tags en base : ${[...evaluable].filter(([, ok]) => !ok).map(([k]) => k).join(', ') || 'aucune'}`);

const db = new Database(args.db);
db.pragma('journal_mode = WAL');
const update = db.prepare('UPDATE pois SET category = ? WHERE id = ?');
const delPoi = db.prepare('DELETE FROM pois WHERE id = ?');
const delRtree = db.prepare('DELETE FROM poi_rtree WHERE id = ?');

const moves = new Map();
const removals = new Map();
let unevaluable = 0;
const pending = [];

for (const row of db.prepare('SELECT id, category, tags FROM pois WHERE source IS NULL').iterate()) {
  let tags;
  try { tags = JSON.parse(row.tags || '{}'); } catch { continue; }
  const next = resolveCategory(tags);
  if (next === row.category) continue;
  if (!explains(tags, row.category) || (next != null && !evaluable.get(next))) { unevaluable++; continue; }
  if (next == null) {
    removals.set(row.category, (removals.get(row.category) || 0) + 1);
  } else {
    const key = `${row.category} → ${next}`;
    moves.set(key, (moves.get(key) || 0) + 1);
  }
  pending.push([row.id, next]);
}

const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
console.log('\n🔁 Changements de catégorie :');
for (const [k, n] of sorted(moves)) console.log(`   ${String(n).padStart(7)}  ${k}`);
console.log('🗑️  Retirés (plus aucune catégorie) :');
for (const [k, n] of sorted(removals)) console.log(`   ${String(n).padStart(7)}  ${k}`);
console.log(`ℹ️  ${unevaluable} ligne(s) laissée(s) : catégorie non réévaluable sur les tags en base`);

if (args.dryRun) {
  console.log('\n(dry-run : rien écrit)');
} else {
  db.transaction(() => {
    for (const [id, next] of pending) {
      if (next == null) { delPoi.run(id); delRtree.run(id); } else update.run(next, id);
    }
  })();
  db.exec('ANALYZE;');
  console.log(`\n✅ ${pending.length} ligne(s) mises à jour`);
}
db.close();
