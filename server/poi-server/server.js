/**
 * RedView POI server — Fastify + SQLite/R*Tree.
 *
 * Déployé sur le VPS Oracle dans `/opt/poi-server` (systemd `poi-server`,
 * écoute sur 127.0.0.1:17778, exposé par le reverse proxy sous `/poi`).
 *
 * La base est construite par `server/poi-ingest/` — voir le README de ce
 * dossier. Ce fichier est la copie de référence : toute modification doit
 * être redéployée sur le VPS.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { db } from './db.js';

const fastify = Fastify({ logger: false });
await fastify.register(cors, { origin: true });

const PORT = parseInt(process.env.POI_PORT || '17778', 10);
const HOST = process.env.POI_HOST || '0.0.0.0';

// `osm_type` n'existe que sur les bases construites par
// server/poi-ingest/import-osm.mjs. On le détecte au démarrage pour que ce
// serveur tourne aussi bien sur une base historique (nodes seuls, sans
// colonne) que sur une base complète — ce qui rend un rollback de base
// indolore.
const HAS_OSM_TYPE = db
  .prepare("SELECT count(*) AS n FROM pragma_table_info('pois') WHERE name = 'osm_type'")
  .get().n > 0;

const SELECT_COLUMNS = HAS_OSM_TYPE
  ? 'p.id, p.osm_id, p.osm_type, p.lat, p.lon, p.category, p.name, p.tags'
  : 'p.id, p.osm_id, NULL AS osm_type, p.lat, p.lon, p.category, p.name, p.tags';

if (!HAS_OSM_TYPE) {
  console.warn('[poi-server] colonne osm_type absente — base historique détectée.');
}

function toFeature(r) {
  return {
    id: r.id,
    osmId: r.osm_id,
    osmType: r.osm_type ?? null,
    lat: r.lat,
    lon: r.lon,
    category: r.category,
    name: r.name,
    tags: r.tags ? JSON.parse(r.tags) : {},
  };
}

// ─── GET /health ────────────────────────────────────────────────────────
fastify.get('/health', async () => {
  const countRow = db.prepare('SELECT count(*) as total FROM pois').get();
  return { status: 'ok', total_pois: countRow.total };
});

// ─── GET /categories ────────────────────────────────────────────────────
fastify.get('/categories', async () => {
  const rows = db.prepare('SELECT category, count(*) as count FROM pois GROUP BY category ORDER BY count DESC').all();
  return { categories: rows };
});

// ─── GET /bbox ──────────────────────────────────────────────────────────
fastify.get('/bbox', async (req, reply) => {
  const { south, west, north, east, categories, limit = '500' } = req.query;

  if (!south || !west || !north || !east) {
    return reply.status(400).send({ error: 'Missing bounds (south, west, north, east)' });
  }

  const s = parseFloat(south);
  const w = parseFloat(west);
  const n = parseFloat(north);
  const e = parseFloat(east);
  const maxLimit = Math.min(parseInt(limit, 10) || 500, 2000);

  const catList = categories ? categories.split(',').map((c) => c.trim()).filter(Boolean) : [];

  let query = `
    SELECT ${SELECT_COLUMNS}
    FROM poi_rtree r
    JOIN pois p ON p.id = r.id
    WHERE r.max_lon >= ? AND r.min_lon <= ?
      AND r.max_lat >= ? AND r.min_lat <= ?
  `;
  const params = [w, e, s, n];

  if (catList.length > 0) {
    const placeholders = catList.map(() => '?').join(',');
    query += ` AND p.category IN (${placeholders})`;
    params.push(...catList);
  }

  query += ` LIMIT ?`;
  params.push(maxLimit);

  const rows = db.prepare(query).all(...params);
  return { features: rows.map(toFeature) };
});

// ─── POST /corridor ─────────────────────────────────────────────────────
//
// Optimisation par grille spatiale.
//
// L'implémentation naïve testait, pour CHAQUE POI candidat, TOUS les segments
// de la trace (avec sortie anticipée uniquement en cas de succès). Tant que
// la base comptait ~325 000 POI c'était acceptable ; avec une base complète
// (plusieurs millions de POI) une requête de corridor sur un long itinéraire
// peut ramener des dizaines de milliers de candidats et faire exploser le
// coût en O(candidats × points).
//
// Ici on indexe d'abord les points d'échantillonnage de la trace dans une
// grille de côté `2 × radius` (pas de 1 m). Un POI ne peut être à moins de
// `radius` d'un segment que si l'un des points de ce segment est dans son
// voisinage 3×3 : on ne teste donc que quelques segments au lieu de tous.
fastify.post('/corridor', async (req, reply) => {
  const { points, radiusM = 1000, categories = [] } = req.body || {};

  if (!Array.isArray(points) || points.length === 0) {
    return reply.status(400).send({ error: 'Missing points array [[lat, lon], ...]' });
  }

  const radius = parseFloat(radiusM) || 1000;
  const degLat = radius / 110574;
  const degLon = radius / (111320 * Math.cos((points[0][0] * Math.PI) / 180));

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  minLat -= degLat; maxLat += degLat;
  minLon -= degLon; maxLon += degLon;

  let query = `
    SELECT ${SELECT_COLUMNS}
    FROM poi_rtree r
    JOIN pois p ON p.id = r.id
    WHERE r.max_lon >= ? AND r.min_lon <= ?
      AND r.max_lat >= ? AND r.min_lat <= ?
  `;
  const params = [minLon, maxLon, minLat, maxLat];

  if (Array.isArray(categories) && categories.length > 0) {
    const placeholders = categories.map(() => '?').join(',');
    query += ` AND p.category IN (${placeholders})`;
    params.push(...categories);
  }

  const candidates = db.prepare(query).all(...params);
  if (candidates.length === 0) return { features: [] };

  // Origine locale en degrés (centre de la trace) pour rester en petits
  // nombres et garder des clés de cellule entières exactes.
  const originLat = (minLat + maxLat) / 2;
  const originLon = (minLon + maxLon) / 2;
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((originLat * Math.PI) / 180);

  const cellM = Math.max(radius * 2, 100);
  const toCellX = (lon) => Math.floor(((lon - originLon) * mPerDegLon) / cellM);
  const toCellY = (lat) => Math.floor(((lat - originLat) * mPerDegLat) / cellM);
  const cellKey = (cx, cy) => `${cx}:${cy}`;

  const grid = new Map();
  for (let i = 0; i < points.length; i++) {
    const key = cellKey(toCellX(points[i][1]), toCellY(points[i][0]));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const radiusSq = radius * radius;
  const accepted = [];

  for (const poi of candidates) {
    const cx = toCellX(poi.lon);
    const cy = toCellY(poi.lat);

    // Segments candidats : ceux adjacents aux points d'échantillonnage du
    // voisinage 3×3 (cellM = 2 × radius couvre largement la condition
    // « POI à moins de radius d'un segment »).
    const segments = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(cellKey(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const idx of bucket) {
          if (idx > 0) segments.add(idx - 1);
          if (idx < points.length - 1) segments.add(idx);
        }
      }
    }

    let minDistanceSq = Infinity;

    for (const i of segments) {
      const [lat1, lon1] = points[i];
      const [lat2, lon2] = points[i + 1];

      const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
      const kx = 111320 * Math.cos(meanLat);
      const ky = 110574;

      const x2 = (lon2 - lon1) * kx;
      const y2 = (lat2 - lat1) * ky;
      const px = (poi.lon - lon1) * kx;
      const py = (poi.lat - lat1) * ky;

      const segLenSq = x2 * x2 + y2 * y2;
      let t = segLenSq === 0 ? 0 : (px * x2 + py * y2) / segLenSq;
      t = Math.max(0, Math.min(1, t));

      const ddx = px - t * x2;
      const ddy = py - t * y2;
      const dSq = ddx * ddx + ddy * ddy;

      if (dSq < minDistanceSq) {
        minDistanceSq = dSq;
        if (minDistanceSq <= radiusSq) break;
      }
    }

    if (minDistanceSq <= radiusSq) {
      accepted.push(toFeature(poi));
    }
  }

  return { features: accepted };
});

fastify.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Serveur POI RedView actif sur ${address}`);
});
