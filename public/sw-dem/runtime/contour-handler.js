// ---------------------------------------------------------------------------
// Handler des courbes de niveau — /contour-tiles/{z}/{x}/{y}
//
// Tuiles vectorielles (MVT) calculées par processing/contours.js sur la tuile
// DEM même du maillage du terrain : `?rv-dem-profile=terrain` en relief 1 m
// (MNT), le profil par défaut sinon (MNS 0,40 m en France, DEM national
// ailleurs, AWS Terrarium hors des emprises HD). Une courbe drapée n'est de
// niveau que sur la surface dont elle est l'isoligne : tirées du MNT sous un
// relief MNS, elles ondulaient de plusieurs mètres sur le rocher. Le prix : en
// 0,40 m, les courbes suivent aussi la canopée et les toits, comme le relief.
//
// Mapbox n'accepte que des tuiles vectorielles de 512 px, demandées à
// floor(zoom), alors que le terrain charge ses tuiles DEM à floor(zoom − 1) : la
// tuile vectorielle z/x/y est donc tirée de la tuile DEM (z − 1, x/2, y/2) — celle
// que le maillage affiche, déjà chargée —, dont elle couvre un quart. Les lignes
// sont calculées une fois par tuile DEM et découpées pour chacun des quatre quarts.
//
// Une tuile construite sur un DEM provisoire (remplaçant, overzoom du parent)
// ou sans sa voisine est / sud (bordure recopiée, comme Mapbox avant que la
// voisine arrive) est servie sans mise en cache ; la page recharge la source sur
// CONTOUR_TILES_STALE quand le DEM qui manquait arrive (derived-tile-stale.js),
// comme la pente.
// ---------------------------------------------------------------------------

// Plage des tuiles vectorielles (contour-source.ts) : en dessous, les courbes de
// Mapbox ; au-dessus, Mapbox suréchantillonne la tuile z17 (DEM z16 ≈ 1,7 m par pixel).
const CONTOUR_MIN_Z = 12;
const CONTOUR_MAX_Z = 17;
const CONTOUR_HOT_CACHE_MAX = 192;
// Lignes définitives par tuile DEM : les quatre quarts arrivent ensemble.
const CONTOUR_DEM_LINES_MAX = 48;

const CONTOUR_DEM_LINES = new Map();
const CONTOUR_DEM_LINES_INFLIGHT = new Map();
const CONTOUR_HOT_CACHE = new Map();
const CONTOUR_INFLIGHT = new Map();
const CONTOUR_STALE_TRACKER = createDerivedTileStaleTracker('CONTOUR_TILES_STALE');

const CONTOUR_CARDINALS = ['e', 's'];

function contourHotGet(key) {
  const bytes = CONTOUR_HOT_CACHE.get(key);
  if (!bytes) return null;
  CONTOUR_HOT_CACHE.delete(key);
  CONTOUR_HOT_CACHE.set(key, bytes);
  return bytes;
}

function contourHotPut(key, bytes) {
  CONTOUR_HOT_CACHE.delete(key);
  CONTOUR_HOT_CACHE.set(key, bytes);
  while (CONTOUR_HOT_CACHE.size > CONTOUR_HOT_CACHE_MAX) {
    CONTOUR_HOT_CACHE.delete(CONTOUR_HOT_CACHE.keys().next().value);
  }
}

function contourHotClear() {
  CONTOUR_HOT_CACHE.clear();
  CONTOUR_DEM_LINES.clear();
}

function contourTileResponse(bytes, final) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-protobuf',
      'Cache-Control': final ? 'public, max-age=604800' : 'no-cache',
      'X-Tile-Type': 'contour',
      'X-Contour-Quality': final ? 'final' : 'provisional',
    },
  });
}

function isFinalContourDem(response) {
  const source = (response.headers.get('X-DEM-Source') || '').toLowerCase();
  return (response.headers.get('X-DEM-Health') || 'ok').toLowerCase() === 'ok'
    && !response.headers.get('x-cache-ttl-ms')
    && !/parent|overzoom|emergency/.test(source);
}

async function decodeContourDem(response) {
  if (!response || response.status !== 200) return null;
  try {
    const elevations = await decodeTerrainRGBBlob(await response.blob());
    return elevations && elevations.length === CONTOUR_DEM_SIZE * CONTOUR_DEM_SIZE ? elevations : null;
  } catch {
    return null;
  }
}

async function handleContourRequest(z, x, y, demProfile = 'default') {
  if (z < CONTOUR_MIN_Z || z > CONTOUR_MAX_Z) return contourTileResponse(new Uint8Array(0), true);

  const profileQuery = demProfile === 'terrain' ? '?rv-dem-profile=terrain' : '';
  const key = `${z}/${x}/${y}${profileQuery}`;
  const hot = contourHotGet(key);
  if (hot) return contourTileResponse(hot, true);

  const contourCache = await caches.open(CONTOUR_CACHE_NAME);
  const cacheKey = new Request(`/contour-tiles/${key}`);
  const cached = await contourCache.match(cacheKey);
  if (cached) {
    try { contourHotPut(key, new Uint8Array(await cached.clone().arrayBuffer())); } catch { /* ignore */ }
    return cached;
  }

  const existing = CONTOUR_INFLIGHT.get(key);
  if (existing) {
    try { return (await existing).clone(); } catch { /* on recalcule */ }
  }

  const work = (async () => {
    const parent = await contourLinesForDemTile(z - 1, x >> 1, y >> 1, contourBaseInterval(z), demProfile);
    if (!parent) {
      // Pas encore de DEM (ou une 204 passagère) : rien à dessiner pour l'instant.
      CONTOUR_STALE_TRACKER.noteStale(key);
      CONTOUR_STALE_TRACKER.waitOnDem(key, demProfile, z - 1, [[x >> 1, y >> 1]]);
      return contourTileResponse(new Uint8Array(0), false);
    }
    let bytes;
    try {
      bytes = encodeContourTile(projectContourLines(parent.lines, 1, x & 1, y & 1));
    } catch (err) {
      console.error('[contour]', z, x, y, err);
      CONTOUR_STALE_TRACKER.noteStale(key);
      return contourTileResponse(new Uint8Array(0), false);
    }
    if (parent.pending.length) {
      CONTOUR_STALE_TRACKER.waitOnDem(key, demProfile, z - 1, parent.pending);
      return contourTileResponse(bytes, false);
    }
    const response = contourTileResponse(bytes, true);
    contourHotPut(key, bytes);
    CONTOUR_STALE_TRACKER.noteFinal(key);
    try { await contourCache.put(cacheKey, response.clone()); } catch { /* quota : au mieux */ }
    return response;
  })();

  CONTOUR_INFLIGHT.set(key, work);
  try {
    return (await work).clone();
  } finally {
    if (CONTOUR_INFLIGHT.get(key) === work) CONTOUR_INFLIGHT.delete(key);
  }
}

/**
 * Lignes de niveau de la tuile DEM z/x/y du profil `demProfile`, avec les tuiles DEM dont
 * l'arrivée les rendrait définitives (`pending` : la sienne si elle est
 * provisoire, ses voisines est / sud absentes ou provisoires). null : pas encore
 * de DEM.
 */
async function contourLinesForDemTile(z, x, y, interval, demProfile) {
  const key = `${demProfile}:${z}/${x}/${y}:${interval}`;
  const done = CONTOUR_DEM_LINES.get(key);
  if (done) return done;
  const existing = CONTOUR_DEM_LINES_INFLIGHT.get(key);
  if (existing) return existing;
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demResponse = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache, '');
    const own = await decodeContourDem(demResponse);
    if (!own) return null;

    // Voisines est / sud / sud-est : seulement ce qui existe déjà ou se construit
    // (jamais de construction pour une bordure) ; une voisine absente est
    // remplacée par le bord recopié, comme dans la texture DEM de Mapbox.
    const n = 2 ** z;
    const neighbours = {};
    const pending = [];
    await Promise.all(Object.entries(CONTOUR_NEIGHBOUR_OFFSETS).map(async ([dir, [dx, dy]]) => {
      const ny = y + dy;
      if (ny < 0 || ny >= n) return;
      const nx = (x + dx + n) % n;
      const response = await getExistingTerrainDemResponse(
        z, nx, ny, demProfile, demCache, '', { allowBuild: false },
      ).catch(() => null);
      const elevations = await decodeContourDem(response);
      if (elevations) neighbours[dir] = elevations;
      if (CONTOUR_CARDINALS.includes(dir) && (!elevations || !isFinalContourDem(response))) pending.push([nx, ny]);
    }));
    if (!isFinalContourDem(demResponse)) pending.push([x, y]);

    const result = { lines: computeContourLines(own, neighbours, interval), pending };
    if (pending.length === 0) {
      CONTOUR_DEM_LINES.set(key, result);
      while (CONTOUR_DEM_LINES.size > CONTOUR_DEM_LINES_MAX) {
        CONTOUR_DEM_LINES.delete(CONTOUR_DEM_LINES.keys().next().value);
      }
    }
    return result;
  })().catch((err) => {
    console.error('[contour] dem', z, x, y, err);
    return null;
  });
  CONTOUR_DEM_LINES_INFLIGHT.set(key, work);
  try {
    return await work;
  } finally {
    if (CONTOUR_DEM_LINES_INFLIGHT.get(key) === work) CONTOUR_DEM_LINES_INFLIGHT.delete(key);
  }
}
