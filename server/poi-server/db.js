import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// POI_DB_PATH permet de faire tourner une instance de test sur une base
// fraîchement construite (data/pois.new.db) sans toucher à la base live.
const dbPath = process.env.POI_DB_PATH
  ? path.resolve(process.env.POI_DB_PATH)
  : path.resolve(__dirname, 'data/pois.db');

// Le serveur ne fait que lire : en production la base est ouverte en lecture
// seule (une faille éventuelle ne peut ni la modifier ni la corrompre).
//   - POI_DB_READONLY=1 force la lecture seule (même en dev) ;
//   - POI_DB_READONLY=0 force la lecture-écriture (même en production) ;
//   - sinon : lecture seule si NODE_ENV=production.
function resolveReadonly() {
  const flag = process.env.POI_DB_READONLY;
  if (flag === '0') return false;
  if (flag === '1') return true;
  return process.env.NODE_ENV === 'production';
}

export const DB_READONLY = resolveReadonly();

export const db = new Database(dbPath, { readonly: DB_READONLY, fileMustExist: DB_READONLY });

if (!DB_READONLY) {
  // Optimisations SQLite pour haute concurrence en lecture. Changer le mode
  // de journal est une écriture : en lecture seule on garde celui laissé par
  // l'ingestion (import-osm.mjs repasse la base en WAL à la fin).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
}
db.pragma('cache_size = -64000'); // 64 Mo de cache RAM

// Schéma produit par server/poi-ingest/import-osm.mjs :
// `osm_type` distingue node / way / relation, et `id` est préfixé par type
// (way = +1e13, relation = +2e13) pour que les namespaces OSM ne se
// percutent jamais.
//
// En lecture-écriture (dev, base vide) on crée les tables si besoin. En lecture
// seule le DDL est impossible : c'est l'ingestion qui DOIT créer `pois`,
// `poi_rtree` (indispensables à chaque requête) et `idx_pois_category`
// (performance). On vérifie donc leur présence et on refuse de démarrer sur une
// base incomplète plutôt que de planter à la première requête.
if (!DB_READONLY) {
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

    CREATE VIRTUAL TABLE IF NOT EXISTS poi_rtree USING rtree(
      id,
      min_lon, max_lon,
      min_lat, max_lat
    );

    CREATE INDEX IF NOT EXISTS idx_pois_category ON pois(category);
  `);
} else {
  const existing = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('pois', 'poi_rtree', 'idx_pois_category')")
      .pluck()
      .all(),
  );
  const missing = ['pois', 'poi_rtree'].filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(
      `[poi-server] base ${dbPath} ouverte en lecture seule mais incomplète (manque : ${missing.join(', ')}). `
      + 'Reconstruire la base avec server/poi-ingest/ ou lancer avec POI_DB_READONLY=0.',
    );
  }
  if (!existing.has('idx_pois_category')) {
    console.warn('[poi-server] index idx_pois_category absent — les filtres par catégorie seront lents.');
  }
}

console.log(`✅ Base de données SQLite R*Tree prête (${DB_READONLY ? 'lecture seule' : 'lecture-écriture'}).`);
