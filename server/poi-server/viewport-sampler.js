/**
 * RedView POI server — échantillonnage spatial pour la vue « POI carte ».
 *
 * Problème : `/bbox … LIMIT n` renvoie les n premières lignes dans l'ordre de
 * parcours du R*Tree, c'est-à-dire un paquet collé dans un coin de la bbox dès
 * qu'elle contient plus de n POI (mesuré en prod : bbox France, limit 300 →
 * 300 POI dans 0,5° × 0,6° autour de Pau ; bbox Lyon → seule la moitié est
 * remplie). Les catégories denses (restaurant, hôtel) étouffent en plus les
 * rares (eau, vélo). En vue dézoomée la carte paraissait donc vide.
 *
 * Solution : une grille Web Mercator par catégorie, alignée sur les tuiles XYZ
 * (niveau L = 2^L × 2^L cellules). Chaque cellule élit un représentant stable
 * — POI nommé d'abord, source OSM ensuite, puis hachage de l'id — et chaque
 * niveau grossier élit parmi les représentants du niveau fin. Conséquences :
 *   - répartition uniforme à l'écran, chaque catégorie a sa place partout ;
 *   - hiérarchie : un POI visible à un niveau le reste en zoomant ;
 *   - l'élu ne dépend que de la cellule, pas de la bbox exacte : pas de
 *     scintillement en panoramique.
 *
 * Niveaux ≤ PYRAMID_MAX_LEVEL : pyramide précalculée au démarrage (un seul
 * balayage de `pois`, quelques secondes pour ~1,3 M POI, ~10 Mo de tableaux
 * typés), requête en O(colonnes × log n). Au-delà la bbox est petite : on lit
 * les POI via le R*Tree et on applique la même élection à la volée.
 */

/** Niveau le plus fin précalculé (cellule ≈ 4,9 km à l'équateur, 3,4 km à 45°). */
const PYRAMID_MAX_LEVEL = 13;
const PYRAMID_MIN_LEVEL = 2;
/** Au-delà, les cellules font moins d'un mètre : inutile. */
const MAX_LEVEL = 24;
/** Garde-fou contre les bbox énormes (vue très inclinée jusqu'à l'horizon). */
const MAX_QUERY_CELLS = 16_384;
/** Au-delà, le chemin à la volée bascule sur la pyramide (déjà bien réparti). */
const RAW_SCAN_LIMIT = 150_000;
const FETCH_BATCH = 500;
const MAX_MERCATOR_LAT = 85.05112878;

// ── Géométrie Web Mercator ────────────────────────────────────────────

function lonToUnit(lon) {
  return (lon + 180) / 360;
}

function latToUnit(lat) {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function toCell(unit, size) {
  return Math.min(size - 1, Math.max(0, Math.floor(unit * size)));
}

// ── Élection ──────────────────────────────────────────────────────────

/** Hachage 32 bits stable d'un entier (jusqu'à 2^53) : départage uniforme. */
function hash53(value) {
  const lo = value % 4294967296 >>> 0;
  const hi = Math.floor(value / 4294967296) >>> 0;
  let h = Math.imul(lo ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(hi + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hashString(value) {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

/** Plus haut = meilleur. Nommé > source OSM > hachage de l'id. */
function electionScore(id, named, osm) {
  return ((named ? 2 : 0) + (osm ? 1 : 0)) * 4294967296 + hash53(id);
}

// ── Pyramide ──────────────────────────────────────────────────────────

/** Premier index i tel que keys[i] >= target (keys trié croissant). */
function lowerBound(keys, target) {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Map<cellKey, {id, score}> → niveau figé en tableaux typés triés. */
function freezeLevel(cells) {
  const keys = [...cells.keys()].sort((a, b) => a - b);
  const frozen = { keys: new Uint32Array(keys.length), ids: new Float64Array(keys.length) };
  keys.forEach((key, i) => {
    frozen.keys[i] = key;
    frozen.ids[i] = cells.get(key).id;
  });
  return frozen;
}

/** Élit, pour chaque cellule du niveau L-1, le meilleur des 4 enfants. */
function coarsen(cells, childSize) {
  const parentSize = childSize / 2;
  const parents = new Map();
  for (const [key, entry] of cells) {
    const x = Math.floor(key / childSize);
    const y = key % childSize;
    const parentKey = (x >> 1) * parentSize + (y >> 1);
    const prev = parents.get(parentKey);
    if (prev === undefined || entry.score > prev.score) parents.set(parentKey, entry);
  }
  return parents;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ hasSource: boolean, selectColumns: string }} options
 */
export function createViewportSampler(db, { hasSource, selectColumns }) {
  const startedAt = Date.now();
  const electionColumns = `p.id, p.lat, p.lon, p.category,
    (p.name IS NOT NULL AND p.name <> '') AS named,
    ${hasSource ? '(p.source IS NULL)' : '1'} AS osm`;

  // category → Array<frozen level | undefined>, indexé par niveau.
  const pyramid = new Map();
  const finestSize = 2 ** PYRAMID_MAX_LEVEL;
  const finest = new Map();

  const scan = db.prepare(`SELECT ${electionColumns} FROM pois p`).raw();
  let scanned = 0;
  for (const [id, lat, lon, category, named, osm] of scan.iterate()) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || typeof category !== 'string') continue;
    scanned += 1;
    const key = toCell(lonToUnit(lon), finestSize) * finestSize + toCell(latToUnit(lat), finestSize);
    const score = electionScore(id, named, osm);
    let cells = finest.get(category);
    if (!cells) {
      cells = new Map();
      finest.set(category, cells);
    }
    const prev = cells.get(key);
    if (prev === undefined || score > prev.score) cells.set(key, { id, score });
  }

  let entries = 0;
  for (const [category, finestCells] of finest) {
    const levels = new Array(PYRAMID_MAX_LEVEL + 1);
    let cells = finestCells;
    for (let level = PYRAMID_MAX_LEVEL; level >= PYRAMID_MIN_LEVEL; level--) {
      levels[level] = freezeLevel(cells);
      entries += cells.size;
      if (level > PYRAMID_MIN_LEVEL) cells = coarsen(cells, 2 ** level);
    }
    pyramid.set(category, levels);
  }
  finest.clear();

  console.log(
    `[poi-server] pyramide d'échantillonnage prête : ${scanned.toLocaleString('fr-FR')} POI, `
    + `${pyramid.size} catégories, ${entries.toLocaleString('fr-FR')} cellules, ${Date.now() - startedAt} ms.`,
  );

  const fetchStatements = new Map();
  function fetchRows(ids) {
    const rows = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      const batch = ids.slice(i, i + FETCH_BATCH);
      let stmt = fetchStatements.get(batch.length);
      if (!stmt) {
        stmt = db.prepare(
          `SELECT ${selectColumns} FROM pois p WHERE p.id IN (${batch.map(() => '?').join(',')})`,
        );
        if (batch.length === FETCH_BATCH) fetchStatements.set(batch.length, stmt);
      }
      rows.push(...stmt.all(...batch));
    }
    return rows;
  }

  /** Candidats {key, category, id} depuis la pyramide. */
  function collectFromPyramid(range, level, categories) {
    const size = 2 ** level;
    const out = [];
    for (const category of categories) {
      const frozen = pyramid.get(category)?.[level];
      if (!frozen || frozen.keys.length === 0) continue;
      for (let x = range.x0; x <= range.x1; x++) {
        const first = x * size + range.y0;
        const last = x * size + range.y1;
        for (let i = lowerBound(frozen.keys, first); i < frozen.keys.length && frozen.keys[i] <= last; i++) {
          out.push({ key: frozen.keys[i], category, id: frozen.ids[i] });
        }
      }
    }
    return out;
  }

  /** Candidats à la volée (niveaux fins) ; null si la bbox est trop dense. */
  function collectFromRtree(bbox, level, categories) {
    // `CROSS JOIN` fige l'ordre (R*Tree d'abord) et `+p.category` interdit
    // l'index de catégorie : sans ça SQLite peut parcourir toute la catégorie
    // puis sonder le R*Tree ligne à ligne (plusieurs secondes sur une petite bbox).
    const sql = `
      SELECT ${electionColumns}
      FROM poi_rtree r
      CROSS JOIN pois p ON p.id = r.id
      WHERE r.max_lon >= ? AND r.min_lon <= ?
        AND r.max_lat >= ? AND r.min_lat <= ?
        AND +p.category IN (${categories.map(() => '?').join(',')})
      LIMIT ?`;
    const rows = db
      .prepare(sql)
      .raw()
      .all(bbox.west, bbox.east, bbox.south, bbox.north, ...categories, RAW_SCAN_LIMIT + 1);
    if (rows.length > RAW_SCAN_LIMIT) return null;

    const size = 2 ** level;
    const winners = new Map();
    for (const [id, lat, lon, category, named, osm] of rows) {
      const key = toCell(lonToUnit(lon), size) * size + toCell(latToUnit(lat), size);
      const slot = `${category}|${key}`;
      const score = electionScore(id, named, osm);
      const prev = winners.get(slot);
      if (prev === undefined || score > prev.score) winners.set(slot, { key, category, id, score });
    }
    return [...winners.values()];
  }

  function cellRange(bbox, level) {
    const size = 2 ** level;
    return {
      x0: toCell(lonToUnit(bbox.west), size),
      x1: toCell(lonToUnit(bbox.east), size),
      y0: toCell(latToUnit(bbox.north), size),
      y1: toCell(latToUnit(bbox.south), size),
    };
  }

  /**
   * @param {{
   *   south: number, west: number, north: number, east: number,
   *   categories: string[], level: number, perCell: number, limit: number,
   * }} query
   * @returns {{ rows: object[], level: number }}
   */
  function sample({ south, west, north, east, categories, level, perCell, limit }) {
    const bbox = {
      south: Math.max(-90, Math.min(south, north)),
      north: Math.min(90, Math.max(south, north)),
      west: Math.max(-180, Math.min(west, east)),
      east: Math.min(180, Math.max(west, east)),
    };
    const wanted = categories.length > 0
      ? categories.filter((c) => pyramid.has(c))
      : [...pyramid.keys()];
    if (wanted.length === 0) return { rows: [], level };

    let effectiveLevel = Math.max(PYRAMID_MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)));
    let range = cellRange(bbox, effectiveLevel);
    while (
      effectiveLevel > PYRAMID_MIN_LEVEL
      && (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1) > MAX_QUERY_CELLS
    ) {
      effectiveLevel -= 1;
      range = cellRange(bbox, effectiveLevel);
    }

    let candidates = null;
    if (effectiveLevel > PYRAMID_MAX_LEVEL) {
      candidates = collectFromRtree(bbox, effectiveLevel, wanted);
    }
    if (candidates === null) {
      effectiveLevel = Math.min(effectiveLevel, PYRAMID_MAX_LEVEL);
      candidates = collectFromPyramid(cellRange(bbox, effectiveLevel), effectiveLevel, wanted);
    }

    // Plusieurs catégories dans une même cellule : on en garde `perCell`,
    // avec une rotation pseudo-aléatoire par cellule pour que chaque catégorie
    // ait la même chance d'apparaître sur l'ensemble de la carte.
    if (perCell > 0) {
      const byCell = new Map();
      for (const candidate of candidates) {
        const rank = hash53(candidate.key) ^ hashString(candidate.category);
        const bucket = byCell.get(candidate.key);
        const item = { candidate, rank: hash53(rank >>> 0) };
        if (bucket) bucket.push(item);
        else byCell.set(candidate.key, [item]);
      }
      candidates = [];
      for (const bucket of byCell.values()) {
        if (bucket.length > perCell) bucket.sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < Math.min(perCell, bucket.length); i++) candidates.push(bucket[i].candidate);
      }
    }

    // Dépassement du plafond : sous-échantillonnage uniforme et stable.
    if (candidates.length > limit) {
      candidates.sort((a, b) => hash53(a.id) - hash53(b.id));
      candidates.length = limit;
    }

    return { rows: fetchRows(candidates.map((c) => c.id)), level: effectiveLevel };
  }

  return { sample };
}
