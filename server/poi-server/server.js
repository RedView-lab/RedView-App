/**
 * RedView POI server — Fastify + SQLite/R*Tree.
 *
 * Déployé sur le VPS Oracle dans `/opt/poi-server` (systemd `poi-server`),
 * exposé par le reverse proxy nginx sous `/poi`. Écoute par défaut sur
 * 127.0.0.1:17778 (boucle locale uniquement, surcharge via `POI_HOST` /
 * `POI_PORT`) : le service n'est appelé que de serveur à serveur
 * (`api/poi.ts`), jamais directement par un navigateur — donc pas de CORS.
 *
 * La base est construite par `server/poi-ingest/` — voir le README de ce
 * dossier. Ce fichier est la copie de référence : toute modification doit
 * être redéployée sur le VPS.
 */
import Fastify from 'fastify';
import { db } from './db.js';
import { createViewportSampler } from './viewport-sampler.js';

// bodyLimit : `api/poi.ts` plafonne déjà le corps à 256 Ko ; 512 Ko laisse
// de la marge sans permettre d'épuiser la mémoire avec un corps géant.
const fastify = Fastify({ logger: false, bodyLimit: 512 * 1024 });

const PORT = parseInt(process.env.POI_PORT || '17778', 10);
const HOST = process.env.POI_HOST || '127.0.0.1';

// Erreurs : on journalise le détail côté serveur mais on ne renvoie jamais
// `err.message` (chemins, SQL, internals) au client.
fastify.setErrorHandler((err, req, reply) => {
  const code = Number(err.statusCode);
  const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 500;
  if (status >= 500) {
    console.error(`[poi-server] erreur interne ${req.method} ${req.url} :`, err);
    return reply.status(status).send({ error: 'Internal error' });
  }
  console.warn(`[poi-server] requête rejetée (${status}) ${req.method} ${req.url} : ${err.message}`);
  return reply.status(status).send({ error: 'Bad request' });
});

fastify.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'Not found' }));

// `osm_type` n'existe que sur les bases construites par
// server/poi-ingest/import-osm.mjs. On le détecte au démarrage pour que ce
// serveur tourne aussi bien sur une base historique (nodes seuls, sans
// colonne) que sur une base complète — ce qui rend un rollback de base
// indolore.
const HAS_OSM_TYPE = db
  .prepare("SELECT count(*) AS n FROM pragma_table_info('pois') WHERE name = 'osm_type'")
  .get().n > 0;

// `source` et `src_confidence` n'existent que sur une base enrichie par les
// sources externes (Overture, AllThePlaces, SIRENE). Même logique de détection
// pour rester compatible avec une base OSM seule.
const HAS_SOURCE = db
  .prepare("SELECT count(*) AS n FROM pragma_table_info('pois') WHERE name = 'source'")
  .get().n > 0;

const SELECT_COLUMNS = [
  'p.id',
  'p.osm_id',
  HAS_OSM_TYPE ? 'p.osm_type' : 'NULL AS osm_type',
  'p.lat', 'p.lon', 'p.category', 'p.name', 'p.tags',
  ...(HAS_SOURCE ? ['p.source', 'p.src_confidence'] : []),
].join(', ');

if (!HAS_OSM_TYPE) {
  console.warn('[poi-server] colonne osm_type absente — base historique détectée.');
}
if (HAS_SOURCE) {
  console.log('[poi-server] base enrichie détectée (colonnes source / src_confidence).');
}

// Échantillonnage spatial de `/bbox?level=…` (vue « POI carte »). Construit
// une fois au démarrage ; en cas d'échec, `/bbox` retombe sur la requête
// historique plutôt que d'empêcher le service de démarrer.
let viewportSampler = null;
try {
  viewportSampler = createViewportSampler(db, { hasSource: HAS_SOURCE, selectColumns: SELECT_COLUMNS });
} catch (err) {
  console.error('[poi-server] échantillonnage spatial indisponible :', err);
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
    // Provenance : `null` = POI OSM (source canonique), sinon la source
    // externe qui l'a apporté. Permet de filtrer ou d'attribuer côté client.
    source: r.source ?? null,
    srcConfidence: r.src_confidence ?? null,
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
//
// `level` (optionnel) active l'échantillonnage spatial : au plus un POI par
// catégorie et par cellule de tuile XYZ de ce niveau (`per_cell` borne en plus
// le nombre de catégories par cellule). Sans `level`, comportement historique :
// les `limit` premiers POI de la bbox, sans garantie de répartition.
const BBOX_DEFAULT_LIMIT = 500;
const BBOX_MAX_LIMIT = 2000;
const BBOX_MAX_LEVEL = 22;
const BBOX_MAX_PER_CELL = 50;
const MAX_CATEGORIES = 64;
const MAX_CATEGORY_LENGTH = 64;
const MAX_SOURCES = 8;
const MAX_SOURCE_LENGTH = 32;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Paramètre de query string : une valeur répétée (`?a=1&a=2`) garde la première. */
function queryParam(value) {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : undefined;
}

/** Liste CSV bornée ; `null` si elle dépasse les limites (→ 400). */
function parseCsvList(raw, maxItems, maxLength) {
  if (!raw) return [];
  const list = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (list.length > maxItems || list.some((x) => x.length > maxLength)) return null;
  return list;
}

fastify.get('/bbox', async (req, reply) => {
  const south = queryParam(req.query.south);
  const west = queryParam(req.query.west);
  const north = queryParam(req.query.north);
  const east = queryParam(req.query.east);
  const categories = queryParam(req.query.categories);
  const sources = queryParam(req.query.sources);
  const limit = queryParam(req.query.limit);
  const level = queryParam(req.query.level);
  const perCell = queryParam(req.query.per_cell);

  if (!south || !west || !north || !east) {
    return reply.status(400).send({ error: 'Missing bounds (south, west, north, east)' });
  }

  const s = parseFloat(south);
  const w = parseFloat(west);
  const n = parseFloat(north);
  const e = parseFloat(east);
  if (
    ![s, w, n, e].every(Number.isFinite)
    || s < -90 || s > 90 || n < -90 || n > 90
    || w < -180 || w > 180 || e < -180 || e > 180
  ) {
    return reply.status(400).send({ error: 'Invalid bounds' });
  }
  // Borne basse indispensable : SQLite traite un LIMIT négatif comme
  // « illimité » (`limit=-1` vidait toute la base).
  const maxLimit = clamp(parseInt(limit, 10) || BBOX_DEFAULT_LIMIT, 1, BBOX_MAX_LIMIT);

  const catList = parseCsvList(categories, MAX_CATEGORIES, MAX_CATEGORY_LENGTH);
  if (catList === null) {
    return reply.status(400).send({ error: 'Invalid categories' });
  }
  const rawSourceList = parseCsvList(sources, MAX_SOURCES, MAX_SOURCE_LENGTH);
  if (rawSourceList === null) {
    return reply.status(400).send({ error: 'Invalid sources' });
  }

  const parsedLevel = parseInt(level, 10);
  const sampleLevel = Number.isFinite(parsedLevel) ? clamp(parsedLevel, 0, BBOX_MAX_LEVEL) : NaN;
  if (viewportSampler && Number.isFinite(sampleLevel) && !sources) {
    const { rows, level: usedLevel } = viewportSampler.sample({
      south: s,
      west: w,
      north: n,
      east: e,
      categories: catList,
      level: sampleLevel,
      perCell: clamp(parseInt(perCell, 10) || 0, 0, BBOX_MAX_PER_CELL),
      limit: maxLimit,
    });
    return { features: rows.map(toFeature), sampled: true, level: usedLevel };
  }

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

  // `sources=osm` restreint aux POI OSM d'origine ; `sources=overture,sirene`
  // aux seuls apports externes. Ignoré sur une base non enrichie.
  const sourceList = HAS_SOURCE ? rawSourceList : [];
  if (sourceList.length > 0) {
    const wantsOsm = sourceList.includes('osm');
    const external = sourceList.filter((x) => x !== 'osm');
    const clauses = [];
    if (wantsOsm) clauses.push('p.source IS NULL');
    if (external.length > 0) {
      clauses.push(`p.source IN (${external.map(() => '?').join(',')})`);
      params.push(...external);
    }
    if (clauses.length > 0) query += ` AND (${clauses.join(' OR ')})`;
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
//
// Candidats : plutôt qu'une seule requête R*Tree sur la bbox de TOUTE la
// trace (un Paris → Nice en diagonale ramenait la moitié de la France), on
// découpe la trace en tronçons consécutifs de CORRIDOR_CHUNK_POINTS points
// (chevauchement d'un point pour couvrir le segment à cheval sur deux
// tronçons) et on interroge la bbox de chaque tronçon élargie du rayon.
// Correction : un POI à moins de `radius` d'un segment est dans la bbox
// élargie du tronçon qui contient ce segment — en latitude par degLat, en
// longitude par degLon calculé au |lat| max du tronçon (cos minimal, donc
// élargissement maximal par rapport au cos de la latitude moyenne du segment
// utilisé dans le calcul de distance ci-dessous).
const CORRIDOR_CHUNK_POINTS = 50;
const CORRIDOR_MAX_CANDIDATES = 300_000;
const CORRIDOR_MAX_POINTS = 10_000;
const CORRIDOR_MAX_RADIUS_M = 10_000;

const corridorSchema = {
  body: {
    type: 'object',
    required: ['points'],
    properties: {
      points: {
        type: 'array',
        minItems: 2,
        maxItems: CORRIDOR_MAX_POINTS,
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: { type: 'number' },
        },
      },
      radiusM: { type: 'number', minimum: 1, maximum: CORRIDOR_MAX_RADIUS_M, default: 1000 },
      categories: {
        type: 'array',
        maxItems: MAX_CATEGORIES,
        items: { type: 'string', maxLength: MAX_CATEGORY_LENGTH },
        default: [],
      },
    },
  },
};

// Une requête préparée par nombre de catégories (0..MAX_CATEGORIES), réutilisée
// d'un tronçon et d'une requête à l'autre.
//
// `CROSS JOIN` fige l'ordre (R*Tree d'abord) et `+p.category` interdit l'index
// de catégorie, comme dans viewport-sampler.js : avec un simple `JOIN … AND
// p.category IN (…)`, SQLite parcourt TOUTE la catégorie via idx_pois_category
// puis sonde le R*Tree ligne à ligne — coût indépendant de la bbox, donc
// multiplié par le nombre de tronçons (mesuré : 8 000 points → 17 s au lieu
// de quelques centaines de ms). Même ensemble de lignes, seul le plan change.
const corridorStatements = new Map();
function corridorStatement(categoryCount) {
  let stmt = corridorStatements.get(categoryCount);
  if (!stmt) {
    let query = `
      SELECT ${SELECT_COLUMNS}
      FROM poi_rtree r
      CROSS JOIN pois p ON p.id = r.id
      WHERE r.max_lon >= ? AND r.min_lon <= ?
        AND r.max_lat >= ? AND r.min_lat <= ?
    `;
    if (categoryCount > 0) {
      query += ` AND +p.category IN (${new Array(categoryCount).fill('?').join(',')})`;
    }
    stmt = db.prepare(query);
    corridorStatements.set(categoryCount, stmt);
  }
  return stmt;
}

fastify.post('/corridor', { schema: corridorSchema }, async (req, reply) => {
  const { points, radiusM, categories } = req.body;

  // JSON accepte 1e999 (→ Infinity) : on revérifie chaque coordonnée.
  for (const [lat, lon] of points) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return reply.status(400).send({ error: 'Invalid points' });
    }
  }

  const radius = radiusM;
  const degLat = radius / 110574;
  const degLon = radius / (111320 * Math.cos((points[0][0] * Math.PI) / 180));

  // Bbox globale : ne sert plus qu'à l'origine de la grille ci-dessous, calculée
  // exactement comme avant pour garder des cellules (et donc des résultats)
  // identiques.
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  minLat -= degLat; maxLat += degLat;
  minLon -= degLon; maxLon += degLon;

  const stmt = corridorStatement(categories.length);
  const byId = new Map();
  for (let start = 0; start < points.length - 1;) {
    const end = Math.min(start + CORRIDOR_CHUNK_POINTS, points.length - 1);

    let cMinLat = 90, cMaxLat = -90, cMinLon = 180, cMaxLon = -180, cMaxAbsLat = 0;
    for (let i = start; i <= end; i++) {
      const [lat, lon] = points[i];
      if (lat < cMinLat) cMinLat = lat;
      if (lat > cMaxLat) cMaxLat = lat;
      if (lon < cMinLon) cMinLon = lon;
      if (lon > cMaxLon) cMaxLon = lon;
      if (Math.abs(lat) > cMaxAbsLat) cMaxAbsLat = Math.abs(lat);
    }
    const cosLat = Math.max(0.01, Math.cos((cMaxAbsLat * Math.PI) / 180));
    const chunkDegLon = radius / (111320 * cosLat);

    for (const row of stmt.iterate(
      cMinLon - chunkDegLon, cMaxLon + chunkDegLon,
      cMinLat - degLat, cMaxLat + degLat,
      ...categories,
    )) {
      if (byId.has(row.id)) continue;
      byId.set(row.id, row);
      if (byId.size > CORRIDOR_MAX_CANDIDATES) {
        // Sortir du for…of referme l'itérateur (et libère la requête).
        return reply.status(413).send({ error: 'Corridor trop large' });
      }
    }

    start = end;
  }

  const candidates = [...byId.values()];
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

try {
  const address = await fastify.listen({ port: PORT, host: HOST });
  console.log(`🚀 Serveur POI RedView actif sur ${address}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
