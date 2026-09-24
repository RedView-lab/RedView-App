/**
 * Banc d'essai : construit une base POI de test avec le schéma de production
 * et y injecte de vrais POI OSM récupérés sur le serveur live (bbox Lyon /
 * Bordeaux / Drôme, les mêmes que l'extrait Overture).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';

const OUT = 'C:/tmp/test/pois.db';
for (const s of ['', '-wal', '-shm']) if (fs.existsSync(OUT + s)) fs.rmSync(OUT + s);

const BOXES = [
  [45.740, 4.820, 45.780, 4.870],
  [44.830, -0.590, 44.860, -0.550],
  [44.500, 5.500, 44.560, 5.600],
];

const db = new Database(OUT);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE pois (
    id INTEGER PRIMARY KEY, osm_id INTEGER, osm_type TEXT,
    lat REAL NOT NULL, lon REAL NOT NULL, category TEXT NOT NULL,
    name TEXT, tags TEXT
  );
  CREATE INDEX idx_pois_category ON pois(category);
  CREATE VIRTUAL TABLE poi_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
`);
const insPoi = db.prepare('INSERT OR REPLACE INTO pois (id, osm_id, osm_type, lat, lon, category, name, tags) VALUES (?,?,?,?,?,?,?,?)');
const insR = db.prepare('INSERT OR REPLACE INTO poi_rtree (id, min_lon, max_lon, min_lat, max_lat) VALUES (?,?,?,?,?)');

let total = 0;
for (const [s, w, n, e] of BOXES) {
  const url = `http://141.145.220.99/poi/bbox?south=${s}&west=${w}&north=${n}&east=${e}&limit=2000`;
  const res = await fetch(url);
  const { features } = await res.json();
  const tx = db.transaction((rows) => {
    for (const f of rows) {
      insPoi.run(f.id, f.osmId, f.osmType || 'node', f.lat, f.lon, f.category, f.name, JSON.stringify(f.tags || {}));
      insR.run(f.id, f.lon, f.lon, f.lat, f.lat);
    }
  });
  tx(features);
  total += features.length;
  console.log(`  bbox ${s},${w} → ${features.length} POI`);
}
const n = db.prepare('SELECT count(*) n FROM pois').get().n;
console.log(`Base de test : ${n.toLocaleString('fr-FR')} POI (${OUT})`);
db.close();
