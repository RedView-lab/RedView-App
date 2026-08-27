// ---------------------------------------------------------------------------
// Orthophoto tiles — IGN ortho clipped to France border polygon
// ---------------------------------------------------------------------------

// France border polygon (loaded lazily from /france-border.json)
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
// Point-in-polygon (ray-casting)
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
// Tile classification (inside / border / outside France polygon)
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
// Canvas masking — clip IGN tile to France border
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
    img.close(); // Release GPU texture memory even if convertToBlob fails
  }
}

// ---------------------------------------------------------------------------
// Ortho tile URL builder & helpers
// ---------------------------------------------------------------------------

function buildOrthoTileURL(z, x, y) {
  return (
    `${IGN_WMTS_BASE}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0` +
    `&LAYER=${IGN_ORTHO_LAYER}&STYLE=normal&FORMAT=image%2Fjpeg` +
    `&TILEMATRIXSET=${IGN_ORTHO_TILEMATRIXSET}` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`
  );
}

let _transparentBlob = null;
async function getTransparentBlob() {
  if (!_transparentBlob) {
    const c = new OffscreenCanvas(1, 1);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 1, 1);
    _transparentBlob = await c.convertToBlob({ type: 'image/png' });
  }
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
// Ortho request handler — uses SEPARATE concurrency limiter from DEM
// ---------------------------------------------------------------------------

// Separate concurrency limiter for ortho tiles (prevents ortho from starving DEM)
let activeOrtho = 0;
const orthoQueue = [];
let orthoPrunedTotal = 0;

function scheduleOrtho(fn) {
  return new Promise((resolve, reject) => {
    orthoQueue.push({ fn, resolve, reject, ts: performance.now() });
    // Drop oldest-by-timestamp entries on overflow so the current viewport
    // survives rapid pans (same strategy as the IGN queue).
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

// Drain queued-but-not-yet-running ortho entries on viewport change.
// Mirror of `flushIGNQueue()` in ign-fetcher.js — see that function for
// the rationale. Paired with `cancelInFlightOrtho()` so the new viewport
// gets all 16 ortho concurrency slots immediately instead of waiting
// up to 8 s for the previous viewport's HTTP responses to land.
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

// In-flight AbortController registry — see ign-fetcher.js for the
// detailed rationale (same pattern). USER_CANCEL_REASON is the abort
// reason used by `cancelInFlightOrtho()`; when the catch handler sees
// it, it skips `orthoNegSet()` so a re-request for the new viewport
// (likely overlapping) actually hits the network.
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

// In-flight deduplication for ortho tiles (same pattern as ignInflight in ign-fetcher.js)
const orthoInflight = new Map();

// In-memory negative cache for failed ortho tiles { key → { ts, ttl } }
const orthoNegCache = new Map();
// Shorter transient TTL than before (was 30 s, then 8 s): a single
// timeout used to freeze a tile through an entire gesture, leaving the
// map blurry too long. At 8 s the screen-edge tiles that race against
// Mapbox's per-tile load order (centre-out) frequently got pruned during
// fast pan and then sat negative-cached past the user's "did it ever
// load?" patience threshold. 3 s lets Mapbox's `raster-fade-duration`
// (default 300 ms) absorb the gap cleanly: a tile that failed once and
// is needed for the next paint is re-fetched almost immediately.
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
  // Evict if too large
  if (orthoNegCache.size > 2000) {
    const iter = orthoNegCache.keys();
    for (let i = 0; i < 500; i++) {
      const k = iter.next().value;
      if (k !== undefined) orthoNegCache.delete(k);
    }
  }
}

// Maximum zoom levels to walk up looking for a cached parent ortho tile
const ORTHO_OVERZOOM_MAX_DEPTH = 3;

// Extract the sub-rectangle of a cached parent tile that corresponds to
// (z, x, y) and upscale it (nearest-neighbor — imagery tolerates it, and
// bilinear doesn't matter visually once Mapbox GL itself resamples).
// Returns a Response or null. Caches the crop under the child key so the
// next identical request is a straight cache hit.
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
            // Short TTL so a real tile can replace this crop quickly
            'Cache-Control': 'public, max-age=60',
            'X-Ortho-Source': `overzoom-z${pZ}`,
          },
        });
        // Do NOT cache the crop under the child key — we want a real fetch
        // to overwrite it next time instead of a positive-cache hit masking
        // genuine ortho data for the full TTL.
        return response;
      } finally {
        img.close();
      }
    } catch {
      // Try next parent level
    }
  }
  return null;
}

async function handleOrthoRequest(z, x, y) {
  const tileKey = `${z}/${x}/${y}`;
  const hotKey = `/ortho-tiles/${tileKey}`;

  // 0. Fast in-memory hit from ORTHO_HOT_CACHE (<1 ms, zero disk I/O)
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

  // Negative cache — skip tiles that recently failed. Try the cropped-parent
  // overzoom before giving up: a recently-timed-out tile is exactly the case
  // where a blurry ancestor tile is better than a transparent hole.
  if (orthoNegGet(tileKey)) {
    const fb = await tryParentOrthoOverzoom(cache, z, x, y);
    if (fb) return fb;
    return await transparentResponse();
  }

  // Get (or start) the in-flight primary fetch for this tile.
  let inflight = orthoInflight.get(tileKey);
  if (!inflight) {
    inflight = (async () => {
      try {
        const polyLoaded = await ensureFrancePoly();

        if (!polyLoaded) {
          // Fallback: fetch without clipping, through ortho concurrency limiter
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

        // Always run the real 5×5 point-in-polygon classifier. The former
        // `z <= 10 → 'border'` short-circuit forced canvas-mask clipping on
        // every low-zoom tile, saturating the OffscreenCanvas pool during fast
        // dezoom (root cause of the "patchwork of missing tiles" artifact).
        // With minzoom=9 on the layer there are now ≤16 ortho tiles at z9 for
        // the full French bbox, so the classifier cost is negligible.
        const classification = classifyOrthoTile(z, x, y);
        if (classification === 'outside') return null;

        // Fetch IGN tile through the ortho concurrency limiter
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
            // User-cancel from CANCEL_STALE_DEM: do NOT negative-cache —
            // a re-request for the (likely overlapping) new viewport must
            // hit the network. Return null so the outer pipeline treats
            // it as "no tile this round" without poisoning future fetches.
            if (isOrthoUserCancel(controller)) return null;
            // Real timeout / network error: let outer catch handle it
            // (it will orthoNegSet with 'transient').
            throw err;
          } finally {
            cleanup();
          }
        });

        // scheduleOrtho may return PRUNED_SENTINEL if the request was pruned from the queue
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

  // Wait for the primary fetch. We intentionally do NOT race against a
  // timeout-based parent-overzoom promotion here: Mapbox already shows its
  // own ancestor tile (already in GPU cache) during loading, and gracefully
  // swaps it for the z=N tile when our 200 arrives (raster-fade-duration).
  //
  // If the SW were to return a cropped parent for a "slow" request, Mapbox
  // would cache that ultra-blurry response in its GPU texture atlas and
  // NEVER re-request the tile — producing the permanent sharp/blurry
  // patchwork the user reported. Parent overzoom is therefore only used on
  // definitive failures below (404, timeout, negative cache): cases where
  // Mapbox would otherwise receive nothing and leave a transparent hole.
  const result = await inflight;
  if (result) return result.clone();
  // Primary returned null → definitive failure. Try parent overzoom so the
  // user sees blurry imagery instead of a transparent hole.
  const fb = await tryParentOrthoOverzoom(cache, z, x, y);
  if (fb) return fb;
  return await transparentResponse();
}
