import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// POI_DB_PATH permet de faire tourner une instance de test sur une base
// fraîchement construite (data/pois.new.db) sans toucher à la base live.
const dbPath = process.env.POI_DB_PATH
  ? path.resolve(process.env.POI_DB_PATH)
  : path.resolve(__dirname, 'data/pois.db');

export const db = new Database(dbPath, { readonly: process.env.POI_DB_READONLY === '1' });

// Optimisations SQLite pour haute concurrence en lecture
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000'); // 64 Mo de cache RAM

// Initialisation des tables avec index spatial R*Tree natif.
// Le schéma est celui produit par server/poi-ingest/import-osm.mjs :
// `osm_type` distingue node / way / relation, et `id` est préfixé par type
// (way = +1e13, relation = +2e13) pour que les namespaces OSM ne se
// percutent jamais.
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

console.log('✅ Base de données SQLite R*Tree prête.');
