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

async function maskOrthoTile(imgBlob, z, tileX, tileY) {
  const img = await createImageBitmap(imgBlob);
  try {
    const canvas = new OffscreenCanvas(ORTHO_TILE_SIZE, ORTHO_TILE_SIZE);
    const ctx = canvas.getContext('2d');
    const b = mercatorTileBounds(z, tileX, tileY);

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
    const blob = await canvas.convertToBlob({ type: 'image/png' });
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

// In-flight deduplication for ortho tiles (same pattern as ignInflight in ign-fetcher.js)
const orthoInflight = new Map();

// In-memory negative cache for failed ortho tiles { key → { ts, ttl } }
const orthoNegCache = new Map();
// Shorter transient TTL than before (was 30 s): a single timeout used to
// freeze a tile through an entire gesture, leaving the map blurry too long.
const ORTHO_NEG_TTL_TRANSIENT = 8_000;   // 8s  — timeout, 5xx, network
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
  const cache = await caches.open(ORTHO_CACHE_NAME);
  const cacheKey = new Request(`/ortho-tiles/${tileKey}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Negative cache — skip tiles that recently failed. Try the cropped-parent
  // overzoom before giving up: a recently-timed-out tile is exactly the case
  // where a blurry ancestor tile is better than a transparent hole.
  if (orthoNegGet(tileKey)) {
    const fb = await tryParentOrthoOverzoom(cache, z, x, y);
    if (fb) return fb;
    return await transparentResponse();
  }

  // Deduplicate: reuse in-flight promise for the same tile. If the in-flight
  // fetch takes longer than ORTHO_INFLIGHT_PROMOTE_MS, we serve a cropped
  // parent tile *now* while letting the real fetch continue in the background
  // and replace the cache entry when it completes. This is what eliminates
  // the dezoom "white holes" without cancelling useful work.
  if (orthoInflight.has(tileKey)) {
    const inflight = orthoInflight.get(tileKey);
    const promoted = await Promise.race([
      inflight.then((r) => ({ ok: true, result: r })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false }), ORTHO_INFLIGHT_PROMOTE_MS)),
    ]);
    if (promoted.ok) {
      return promoted.result ? promoted.result.clone() : await transparentResponse();
    }
    // Still in flight after the promotion window — serve a parent crop.
    const fb = await tryParentOrthoOverzoom(cache, z, x, y);
    if (fb) return fb;
    // No parent available either — wait the inflight out (no alternative).
    const result = await inflight;
    return result ? result.clone() : await transparentResponse();
  }

  const promise = (async () => {
    try {
      const polyLoaded = await ensureFrancePoly();

      if (!polyLoaded) {
        // Fallback: fetch without clipping, through ortho concurrency limiter
        const response = await scheduleOrtho(async () => {
          const url = buildOrthoTileURL(z, x, y);
          const res = await fetch(url, { signal: AbortSignal.timeout(ORTHO_FETCH_TIMEOUT_MS) });
          if (!res.ok) return null;
          return new Response(await res.blob(), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' },
          });
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
        const res = await fetch(url, { signal: AbortSignal.timeout(ORTHO_FETCH_TIMEOUT_MS) });
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
      });

      // scheduleOrtho may return PRUNED_SENTINEL if the request was pruned from the queue
      if (!fetchResult || fetchResult === PRUNED_SENTINEL) {
        // Parent-tile overzoom fallback — serve a cropped cached ancestor so
        // the user sees imagery (slightly blurry) instead of transparent,
        // matching how Mapbox natively handles missing raster tiles.
        const fb = await tryParentOrthoOverzoom(cache, z, x, y);
        if (fb) return fb;
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
      return response;
    } catch (err) {
      // AbortSignal.timeout() throws with name === 'TimeoutError'; manual
      // AbortController signals throw 'AbortError'. Both are non-error flow
      // control: mark the tile as transiently failed, attempt the cropped
      // parent-overzoom, and stay quiet in the console.
      const name = err && err.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        orthoNegSet(tileKey, 'transient');
        const fb = await tryParentOrthoOverzoom(cache, z, x, y);
        if (fb) return fb;
        return null;
      }
      orthoNegSet(tileKey, 'transient');
      console.error('[sw-dem] Ortho error', z, x, y, err);
      return null;
    }
  })().finally(() => {
    orthoInflight.delete(tileKey);
  });

  orthoInflight.set(tileKey, promise);
  const result = await promise;
  return result ? result : await transparentResponse();
}
