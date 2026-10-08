// ---------------------------------------------------------------------------
// Tuiles d'orthophotos — ortho IGN découpée sur le polygone de la frontière française
// ---------------------------------------------------------------------------

// Polygone de la frontière française (chargé à la demande depuis /france-border.json)
let francePoly = null;
let francePolyBBoxes = null;
let francePolyLoading = null;

async function ensureFrancePoly() {
  if (francePoly) return true;
  if (francePolyLoading) return francePolyLoading;
  francePolyLoading = (async () => {
    let response;
    const staticCache = await caches.open(STATIC_CACHE_NAME);
    response = await staticCache.match('/france-border.json');
    if (!response) {
      response = await fetch('/france-border.json');
      if (response.ok) staticCache.put('/france-border.json', response.clone());
    }
    return response.json();
  })()
    .then(geo => {
      francePoly = geo.coordinates;
      francePolyBBoxes = francePoly.map(polygon => {
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const ring of polygon) {
          for (const [lng, lat] of ring) {
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
        }
        return [minLng, minLat, maxLng, maxLat];
      });
      francePolyEdgeGrid = buildFrancePolyEdgeGrid(francePoly);
      return true;
    })
    .catch(err => {
      console.error('[sw-dem] Failed to load France polygon:', err);
      francePoly = null;
      francePolyLoading = null;
      return false;
    });
  return francePolyLoading;
}

// ---------------------------------------------------------------------------
// Point dans un polygone (lancer de rayon)
// ---------------------------------------------------------------------------

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInFrance(lng, lat) {
  if (!francePoly) return false;
  if (francePolyEdgeGrid) return pointInFranceGrid(lng, lat);
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (lng < bw || lng > be || lat < bs || lat > bn) continue;
    const polygon = francePoly[p];
    if (pointInRing(lng, lat, polygon[0])) {
      let inHole = false;
      for (let h = 1; h < polygon.length; h++) {
        if (pointInRing(lng, lat, polygon[h])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Classement des tuiles (dans / en bordure / hors du polygone France)
// ---------------------------------------------------------------------------

function classifyOrthoTile(z, x, y) {
  if (!francePoly) return 'outside';
  const b = mercatorTileBounds(z, x, y);
  let insideCount = 0;
  const N = 5;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const lng = b.west + (b.east - b.west) * (i + 0.5) / N;
      const lat = b.south + (b.north - b.south) * (j + 0.5) / N;
      if (pointInFrance(lng, lat)) insideCount++;
    }
  }
  const total = N * N;
  if (insideCount > 0 && insideCount < total) return 'border';
  if (hasPolyVertexInTile(b)) return 'border';
  return insideCount === total ? 'inside' : 'outside';
}

function hasPolyVertexInTile(b) {
  if (!francePoly) return false;
  if (francePolyEdgeGrid) {
    // Chaque sommet est le point de départ d'une arête indexée.
    return forEachGridEdge(b, (x1, y1) => (
      x1 >= b.west && x1 <= b.east && y1 >= b.south && y1 <= b.north
    ));
  }
  for (let p = 0; p < francePoly.length; p++) {
    const [bw, bs, be, bn] = francePolyBBoxes[p];
    if (be < b.west || bw > b.east || bn < b.south || bs > b.north) continue;
    for (const ring of francePoly[p]) {
      for (const [lng, lat] of ring) {
        if (lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Index spatial des arêtes de la frontière
// ---------------------------------------------------------------------------
// Le polygone métropolitain compte des dizaines de milliers de sommets et sa
// bbox recouvre toutes les tuiles de la région : le parcourir pour chaque tuile
// coûte cher, et un test de bbox est bien trop généreux (il classait le
// nord-ouest de l'Italie, la Belgique, le Luxembourg et le sud-ouest de
// l'Allemagne en « border »). Les arêtes sont réparties une fois pour toutes,
// au chargement, dans une grille lng/lat fixe ; une requête de tuile ne visite
// que les quelques cellules qu'elle couvre.

const FRANCE_EDGE_GRID_CELL_DEG = 0.05;
const FRANCE_EDGE_GRID_ROWS = Math.ceil(180 / FRANCE_EDGE_GRID_CELL_DEG) + 1;
let francePolyEdgeGrid = null;
let francePolyEdgeGridMaxCol = -1;

function franceEdgeGridCol(lng) {
  return Math.floor((lng + 180) / FRANCE_EDGE_GRID_CELL_DEG);
}

function franceEdgeGridRow(lat) {
  return Math.floor((lat + 90) / FRANCE_EDGE_GRID_CELL_DEG);
}

function buildFrancePolyEdgeGrid(polygons) {
  const grid = new Map();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        const c0 = franceEdgeGridCol(Math.min(x1, x2));
        const c1 = franceEdgeGridCol(Math.max(x1, x2));
        const r0 = franceEdgeGridRow(Math.min(y1, y2));
        const r1 = franceEdgeGridRow(Math.max(y1, y2));
        if (c1 > francePolyEdgeGridMaxCol) francePolyEdgeGridMaxCol = c1;
        for (let c = c0; c <= c1; c++) {
          for (let r = r0; r <= r1; r++) {
            const key = c * FRANCE_EDGE_GRID_ROWS + r;
            let bucket = grid.get(key);
            if (!bucket) {
              bucket = [];
              grid.set(key, bucket);
            }
            bucket.push(x1, y1, x2, y2);
          }
        }
      }
    }
  }
  return grid;
}

// Appelle `test(x1, y1, x2, y2)` pour chaque arête indexée dans les cellules
// couvrant `b` ; renvoie true dès qu'un appel renvoie true. Une arête qui
// s'étend sur plusieurs cellules peut être visitée plusieurs fois — sans effet
// pour un prédicat.
function forEachGridEdge(b, test) {
  const c0 = franceEdgeGridCol(b.west);
  const c1 = franceEdgeGridCol(b.east);
  const r0 = franceEdgeGridRow(b.south);
  const r1 = franceEdgeGridRow(b.north);
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      const bucket = francePolyEdgeGrid.get(c * FRANCE_EDGE_GRID_ROWS + r);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i += 4) {
        if (test(bucket[i], bucket[i + 1], bucket[i + 2], bucket[i + 3])) return true;
      }
    }
  }
  return false;
}

// Lancer de rayon pair-impair vers +lng, limité à la ligne de la grille qui
// contient `lat`. Même règle de croisement que pointInRing() ; tous les anneaux
// de tous les polygones sont comptés ensemble, ce qui gère les trous et les îles
// disjointes (l'enclave espagnole de Llívia est stockée comme un polygone qui
// recouvre celui du continent : le pair-impair la classe bien hors de France).
// Une arête indexée dans plusieurs cellules n'est comptée que dans la cellule
// qui contient son point de croisement.
function pointInFranceGrid(lng, lat) {
  const row = franceEdgeGridRow(lat);
  let inside = false;
  for (let c = franceEdgeGridCol(lng); c <= francePolyEdgeGridMaxCol; c++) {
    const bucket = francePolyEdgeGrid.get(c * FRANCE_EDGE_GRID_ROWS + row);
    if (!bucket) continue;
    const cellWest = c * FRANCE_EDGE_GRID_CELL_DEG - 180;
    const cellEast = cellWest + FRANCE_EDGE_GRID_CELL_DEG;
    for (let i = 0; i < bucket.length; i += 4) {
      const xi = bucket[i], yi = bucket[i + 1];
      const xj = bucket[i + 2], yj = bucket[i + 3];
      if ((yi > lat) === (yj > lat)) continue;
      // Borné pour qu'un arrondi ne puisse jamais l'envoyer dans une cellule où l'arête n'est pas indexée.
      const xCross = Math.min(Math.max((xj - xi) * (lat - yi) / (yj - yi) + xi, Math.min(xi, xj)), Math.max(xi, xj));
      if (xCross <= lng) continue;
      if (franceEdgeGridCol(xCross) !== c) continue;
      inside = !inside;
    }
  }
  return inside;
}

// Liang–Barsky : le segment (x1,y1)→(x2,y2) touche-t-il le rectangle ?
function segmentIntersectsRect(x1, y1, x2, y2, w, s, e, n) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - w, e - x1, y1 - s, n - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/**
 * Vrai quand une arête de la frontière française traverse les bornes `b` de la
 * tuile élargies de `marginLng` / `marginLat` degrés. Rattrape les tuiles de
 * sommet ou de crête dont la frange française est trop fine pour
 * l'échantillonnage 6×6, sans revendiquer des tuiles étrangères simplement
 * situées dans la bbox de la France.
 */
function franceBorderNearBBox(b, marginLng, marginLat) {
  if (!francePoly || !francePolyEdgeGrid) return false;
  const w = b.west - marginLng;
  const e = b.east + marginLng;
  const s = b.south - marginLat;
  const n = b.north + marginLat;
  return forEachGridEdge(
    { west: w, east: e, south: s, north: n },
    (x1, y1, x2, y2) => segmentIntersectsRect(x1, y1, x2, y2, w, s, e, n),
  );
}

// ---------------------------------------------------------------------------
// Masquage par canvas — découpe la tuile IGN sur la frontière française
// ---------------------------------------------------------------------------

function lngToTilePx(lng, z, tileX, size) {
  const n = 1 << z;
  return (((lng + 180) / 360) * n - tileX) * size;
}

function latToTilePy(lat, z, tileY, size) {
  const n = 1 << z;
  const latRad = lat * Math.PI / 180;
  const mercY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return (mercY - tileY) * size;
}

let _sharedOrthoMaskCanvas = null;
let _sharedOrthoMaskCtx = null;

function getSharedOrthoMaskCtx(size) {
  if (!_sharedOrthoMaskCanvas) {
    _sharedOrthoMaskCanvas = new OffscreenCanvas(size, size);
    _sharedOrthoMaskCtx = _sharedOrthoMaskCanvas.getContext('2d', {
      willReadFrequently: true,
    });
  } else if (_sharedOrthoMaskCanvas.width !== size || _sharedOrthoMaskCanvas.height !== size) {
    _sharedOrthoMaskCanvas.width = size;
    _sharedOrthoMaskCanvas.height = size;
    _sharedOrthoMaskCtx = _sharedOrthoMaskCanvas.getContext('2d', {
      willReadFrequently: true,
    });
  }
  return _sharedOrthoMaskCtx;
}

async function maskOrthoTile(imgBlob, z, tileX, tileY) {
  const img = await createImageBitmap(imgBlob);
  try {
    const ctx = getSharedOrthoMaskCtx(ORTHO_TILE_SIZE);
    ctx.clearRect(0, 0, ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
    const b = mercatorTileBounds(z, tileX, tileY);

    ctx.save();
    ctx.beginPath();
    for (let p = 0; p < francePoly.length; p++) {
      const [bw, bs, be, bn] = francePolyBBoxes[p];
      if (be < b.west - 1 || bw > b.east + 1 || bn < b.south - 1 || bs > b.north + 1) continue;

      for (const ring of francePoly[p]) {
        let first = true;
        for (const [lng, lat] of ring) {
          const px = lngToTilePx(lng, z, tileX, ORTHO_TILE_SIZE);
          const py = latToTilePy(lat, z, tileY, ORTHO_TILE_SIZE);
          if (first) { ctx.moveTo(px, py); first = false; }
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    }
    ctx.clip();
    ctx.drawImage(img, 0, 0, ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
    ctx.restore();
    const blob = await _sharedOrthoMaskCanvas.convertToBlob({ type: 'image/png' });
    return blob;
  } finally {
    img.close(); // Libère la mémoire de texture GPU même si convertToBlob échoue
  }
}

// ---------------------------------------------------------------------------
// Construction des URL de tuiles ortho et aides
// ---------------------------------------------------------------------------

function buildOrthoTileURL(z, x, y) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image%2Fjpeg` +
    `&TILEMATRIXSET=${IGN_ORTHO_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`
  );
}

// Même PNG transparent 1×1 vérifié que runtime/dem-helpers.js (TRANSPARENT_PNG,
// global de la chaîne de scripts classiques) : pas d'encodage OffscreenCanvas,
// donc une tuile ortho manquante ne peut jamais devenir un fetch rejeté
// (audit d-sw-router).
let _transparentBlob = null;
async function getTransparentBlob() {
  _transparentBlob ??= new Blob([TRANSPARENT_PNG], { type: 'image/png' });
  return _transparentBlob;
}

async function transparentResponse() {
  const blob = await getTransparentBlob();
  return new Response(blob, {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

// ---------------------------------------------------------------------------
// Handler des requêtes ortho — limiteur de concurrence DISTINCT de celui du DEM
// ---------------------------------------------------------------------------

// Limiteur de concurrence propre aux tuiles ortho (l'ortho n'affame pas le DEM)
let activeOrtho = 0;
const orthoQueue = [];
let orthoPrunedTotal = 0;

function scheduleOrtho(fn) {
  return new Promise((resolve, reject) => {
    orthoQueue.push({ fn, resolve, reject, ts: performance.now() });
    // En cas de débordement, abandonne les entrées les plus anciennes par date,
    // pour que la vue courante survive aux déplacements rapides (même stratégie
    // que la file IGN).
    let pruned = 0;
    while (orthoQueue.length > ORTHO_QUEUE_MAX) {
      let oldestIdx = 0;
      let oldestTs = orthoQueue[0].ts;
      for (let i = 1; i < orthoQueue.length; i++) {
        if (orthoQueue[i].ts < oldestTs) { oldestTs = orthoQueue[i].ts; oldestIdx = i; }
      }
      const stale = orthoQueue.splice(oldestIdx, 1)[0];
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
    if (pruned > 0) {
      orthoPrunedTotal += pruned;
      if (DEBUG) console.warn(
        `[sw-dem][ortho-queue] pruned ${pruned} (queue=${orthoQueue.length}, active=${activeOrtho}/${ORTHO_CONCURRENCY}, lifetime=${orthoPrunedTotal})`,
      );
    }
    drainOrtho();
  });
}

function drainOrtho() {
  while (activeOrtho < ORTHO_CONCURRENCY && orthoQueue.length > 0) {
    const { fn, resolve, reject } = orthoQueue.pop();
    activeOrtho++;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeOrtho--;
        drainOrtho();
      });
  }
}

// Vide les entrées ortho en file mais pas encore lancées quand la vue change.
// Pendant de `flushIGNQueue()` dans ign-scheduler.js — voir cette fonction pour
// la justification. Associé à `cancelInFlightOrtho()`, pour que la nouvelle vue
// dispose tout de suite des 16 créneaux ortho au lieu d'attendre jusqu'à 8 s
// les réponses HTTP de la vue précédente.
function flushOrthoQueue() {
  if (orthoQueue.length === 0) return 0;
  const pruned = orthoQueue.length;
  while (orthoQueue.length > 0) {
    const stale = orthoQueue.pop();
    stale.resolve(PRUNED_SENTINEL);
  }
  orthoPrunedTotal += pruned;
  if (DEBUG) console.warn(`[sw-dem][ortho-queue] flushed ${pruned} stale on viewport change`);
  return pruned;
}

// Registre des AbortController en cours — voir ign-network.js pour la
// justification détaillée (même schéma). USER_CANCEL_REASON est la raison
// d'annulation utilisée par `cancelInFlightOrtho()` ; quand le gestionnaire
// d'erreur la voit, il saute `orthoNegSet()`, pour qu'une nouvelle demande de
// la nouvelle vue (qui recoupe probablement l'ancienne) atteigne bien le réseau.
const orthoActiveControllers = new Set();

function orthoFetchInit() {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try { controller.abort('rv-ortho-timeout'); } catch { /* ignore */ }
  }, ORTHO_FETCH_TIMEOUT_MS);
  orthoActiveControllers.add(controller);
  const cleanup = () => {
    clearTimeout(timeout);
    orthoActiveControllers.delete(controller);
  };
  return {
    controller,
    cleanup,
    init: { signal: controller.signal, priority: 'high' },
  };
}

function isOrthoUserCancel(controller) {
  return controller.signal.aborted && controller.signal.reason === USER_CANCEL_REASON;
}

function cancelInFlightOrtho() {
  if (orthoActiveControllers.size === 0) return 0;
  let n = 0;
  for (const c of orthoActiveControllers) {
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
  }
  orthoActiveControllers.clear();
  if (DEBUG) console.warn(`[sw-dem][ortho-queue] aborted ${n} in-flight ortho fetches on viewport change`);
  return n;
}

// Déduplication des requêtes ortho en cours (même schéma qu'ignInflight dans ign-scheduler.js)
const orthoInflight = new Map();

// Cache négatif en mémoire des tuiles ortho en échec { clé → { ts, ttl } }
const orthoNegCache = new Map();
// TTL passager plus court qu'avant (30 s, puis 8 s) : un seul délai dépassé
// figeait une tuile pendant tout un geste et laissait la carte floue trop
// longtemps. À 8 s, les tuiles du bord de l'écran, en concurrence avec l'ordre
// de chargement de Mapbox (du centre vers les bords), étaient souvent élaguées
// pendant un déplacement rapide puis restaient en cache négatif au-delà du
// seuil de patience de l'utilisateur (« elle va se charger un jour ? »). 3 s
// laissent le `raster-fade-duration` de Mapbox (300 ms par défaut) absorber
// proprement le trou : une tuile qui a échoué une fois et qui est nécessaire
// au prochain rendu est redemandée presque tout de suite.
const ORTHO_NEG_TTL_TRANSIENT = 3_000;   // 3s  — timeout, 5xx, network
const ORTHO_NEG_TTL_PERMANENT = 3600_000; // 1h — 404

function orthoNegGet(key) {
  if (!orthoNegCache.has(key)) return false;
  const entry = orthoNegCache.get(key);
  if (Date.now() - entry.ts < entry.ttl) return true;
  orthoNegCache.delete(key);
  return false;
}

function orthoNegSet(key, errorType) {
  const ttl = errorType === 'permanent' ? ORTHO_NEG_TTL_PERMANENT : ORTHO_NEG_TTL_TRANSIENT;
  orthoNegCache.set(key, { ts: Date.now(), ttl });
  // Éviction si trop gros
  if (orthoNegCache.size > 2000) {
    const iter = orthoNegCache.keys();
    for (let i = 0; i < 500; i++) {
      const k = iter.next().value;
      if (k !== undefined) orthoNegCache.delete(k);
    }
  }
}

// Nombre maximal de niveaux de zoom à remonter pour trouver une tuile ortho parente en cache
const ORTHO_OVERZOOM_MAX_DEPTH = 3;

// Extrait le sous-rectangle d'une tuile parente en cache qui correspond à
// (z, x, y) et l'agrandit (plus proche voisin — l'imagerie le supporte, et le
// bilinéaire ne change rien visuellement une fois que Mapbox GL rééchantillonne
// lui-même). Renvoie une Response ou null. Met le recadrage en cache sous la
// clé de l'enfant, pour que la prochaine requête identique soit servie
// directement depuis le cache.
async function tryParentOrthoOverzoom(cache, z, x, y) {
  for (let dz = 1; dz <= ORTHO_OVERZOOM_MAX_DEPTH; dz++) {
    const pZ = z - dz;
    if (pZ < 0) break;
    const pX = x >> dz;
    const pY = y >> dz;
    const parentResp = await cache.match(new Request(`/ortho-tiles/${pZ}/${pX}/${pY}`));
    if (!parentResp) continue;
    try {
      const parentBlob = await parentResp.clone().blob();
      const img = await createImageBitmap(parentBlob);
      try {
        const nChildren = 1 << dz;
        const srcSize = ORTHO_TILE_SIZE / nChildren;
        const cx = x - (pX << dz);
        const cy = y - (pY << dz);
        const srcX = cx * srcSize;
        const srcY = cy * srcSize;
        const canvas = new OffscreenCanvas(ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(
          img,
          srcX, srcY, srcSize, srcSize,
          0, 0, ORTHO_TILE_SIZE, ORTHO_TILE_SIZE,
        );
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const response = new Response(blob, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            // TTL court, pour qu'une vraie tuile puisse vite remplacer ce recadrage
            'Cache-Control': 'public, max-age=60',
            'X-Ortho-Source': `overzoom-z${pZ}`,
          },
        });
        // NE PAS mettre le recadrage en cache sous la clé de l'enfant — on veut
        // qu'un vrai fetch l'écrase la prochaine fois, plutôt qu'un succès en
        // cache masque les vraies données ortho pendant tout le TTL.
        return response;
      } finally {
        img.close();
      }
    } catch {
      // Essaie le niveau parent suivant
    }
  }
  return null;
}

async function handleOrthoRequest(z, x, y) {
  const tileKey = `${z}/${x}/${y}`;
  const hotKey = `/ortho-tiles/${tileKey}`;

  // 0. Succès rapide en mémoire depuis ORTHO_HOT_CACHE (< 1 ms, aucune E/S disque)
  if (typeof orthoHotGet === 'function') {
    const hot = orthoHotGet(hotKey);
    if (hot) return orthoHotResponse(hot);
  }

  const cache = await caches.open(ORTHO_CACHE_NAME);
  const cacheKey = new Request(hotKey);
  const cached = await cache.match(cacheKey);
  if (cached) {
    if (typeof orthoHotPut === 'function') {
      try {
        orthoHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
      } catch { /* ignore */ }
    }
    return cached;
  }

  // Cache négatif — on saute les tuiles qui ont échoué récemment. On tente
  // l'overzoom du parent recadré avant d'abandonner : une tuile qui vient de
  // dépasser son délai est exactement le cas où une tuile ancêtre floue vaut
  // mieux qu'un trou transparent.
  if (orthoNegGet(tileKey)) {
    const fb = await tryParentOrthoOverzoom(cache, z, x, y);
    if (fb) return fb;
    return await transparentResponse();
  }

  // Récupère (ou lance) le fetch principal en cours pour cette tuile.
  let inflight = orthoInflight.get(tileKey);
  if (!inflight) {
    inflight = (async () => {
      try {
        const polyLoaded = await ensureFrancePoly();

        if (!polyLoaded) {
          // Repli : fetch sans découpe, via le limiteur de concurrence ortho
          const response = await scheduleOrtho(async () => {
            const url = buildOrthoTileURL(z, x, y);
            const { cleanup, init } = orthoFetchInit();
            try {
              const res = await fetch(url, init);
              if (!res.ok) return null;
              return new Response(await res.blob(), {
                status: 200,
                headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
              });
            } finally {
              cleanup();
            }
          });
          if (!response || response === PRUNED_SENTINEL) return null;
          cache.put(cacheKey, response.clone());
          return response;
        }

        if (!tileOverlapsFrance(z, x, y)) return null;

        // On lance toujours le vrai classificateur point-dans-polygone 5×5.
        // L'ancien raccourci `z <= 10 → 'border'` imposait la découpe par
        // masque canvas à chaque tuile de faible zoom et saturait le pool
        // d'OffscreenCanvas pendant un dézoom rapide (cause de l'artefact
        // « patchwork de tuiles manquantes »). Avec minzoom=9 sur la couche, il
        // n'y a plus que ≤ 16 tuiles ortho à z9 pour toute la bbox française :
        // le coût du classificateur est négligeable.
        const classification = classifyOrthoTile(z, x, y);
        if (classification === 'outside') return null;

        // Récupère la tuile IGN via le limiteur de concurrence ortho
        const fetchResult = await scheduleOrtho(async () => {
          const url = buildOrthoTileURL(z, x, y);
          const { controller, cleanup, init } = orthoFetchInit();
          try {
            const res = await fetch(url, init);
            if (!res.ok) {
              const errorType = res.status === 404 ? 'permanent' : 'transient';
              orthoNegSet(tileKey, errorType);
              return null;
            }
            const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
            if (!contentType.startsWith('image/')) {
              orthoNegSet(tileKey, 'permanent');
              return null;
            }
            return await res.blob();
          } catch (err) {
            // Annulation utilisateur venant de CANCEL_STALE_DEM : PAS de cache
            // négatif — une nouvelle demande pour la nouvelle vue (qui recoupe
            // probablement l'ancienne) doit atteindre le réseau. On renvoie null
            // pour que le pipeline extérieur traite le cas comme « pas de tuile
            // ce tour-ci » sans empoisonner les fetchs suivants.
            if (isOrthoUserCancel(controller)) return null;
            // Vrai délai dépassé / erreur réseau : laisser le catch extérieur s'en
            // charger (il appellera orthoNegSet avec 'transient').
            throw err;
          } finally {
            cleanup();
          }
        });

        // scheduleOrtho peut renvoyer PRUNED_SENTINEL si la requête a été élaguée de la file
        if (!fetchResult || fetchResult === PRUNED_SENTINEL) {
          return null;
        }

        let response;
        if (classification === 'inside') {
          response = new Response(fetchResult, {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
          });
        } else {
          const maskedPng = await maskOrthoTile(fetchResult, z, x, y);
          response = new Response(maskedPng, {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' },
          });
        }

        cache.put(cacheKey, response.clone());
        if (typeof orthoHotPut === 'function') {
          try {
            orthoHotPut(hotKey, await response.clone().blob(), Array.from(response.headers.entries()));
          } catch { /* ignore */ }
        }
        return response;
      } catch (err) {
        const name = err && err.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          orthoNegSet(tileKey, 'transient');
          return null;
        }
        orthoNegSet(tileKey, 'transient');
        console.error('[sw-dem] Ortho error', z, x, y, err);
        return null;
      }
    })().finally(() => {
      orthoInflight.delete(tileKey);
    });
    orthoInflight.set(tileKey, inflight);
  }

  // On attend le fetch principal. On ne le met volontairement PAS en
  // concurrence avec une promotion du parent suréchantillonné déclenchée par un
  // délai : Mapbox affiche déjà sa propre tuile ancêtre (déjà en cache GPU)
  // pendant le chargement, puis la remplace en douceur par la tuile z=N quand
  // notre 200 arrive (raster-fade-duration).
  //
  // Si le SW renvoyait un parent recadré pour une requête « lente », Mapbox
  // garderait cette réponse ultra-floue dans son atlas de textures GPU et NE
  // redemanderait JAMAIS la tuile — d'où le patchwork permanent net/flou signalé
  // par l'utilisateur. L'overzoom du parent ne sert donc qu'aux échecs
  // définitifs ci-dessous (404, délai dépassé, cache négatif) : les cas où
  // Mapbox ne recevrait rien et laisserait un trou transparent.
  const result = await inflight;
  if (result) return result.clone();
  // Le fetch principal a renvoyé null → échec définitif. On tente l'overzoom du
  // parent pour que l'utilisateur voie une imagerie floue plutôt qu'un trou transparent.
  const fb = await tryParentOrthoOverzoom(cache, z, x, y);
  if (fb) return fb;
  return await transparentResponse();
}
