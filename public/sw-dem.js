// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho tile processor
// Entry point — loads sub-modules via importScripts()
//
// Contract with the page (useMap.ts):
//   1. page registers SW and waits for controllerchange
//   2. page posts { type: 'SET_MAPBOX_TOKEN', token } and waits for TOKEN_ACK
//   3. ONLY THEN does the page add /dem-tiles/ and /ortho-tiles/ sources
//
// Consequence: when a DEM request reaches this SW, mapboxToken is guaranteed
// to be set. If it isn't (SW restart mid-session, etc.), we return 204 and
// let Mapbox GL reuse parent tiles — identical to how plain Mapbox handles
// missing raster-dem tiles. We NEVER return a fake "flat" elevation tile,
// which would show the user a lying-flat terrain mesh.
// ---------------------------------------------------------------------------

importScripts(
  '/sw-dem/config.js',
  '/sw-dem/geo.js',
  '/sw-dem/interpolation.js',
  '/sw-dem/terrain-rgb.js',
  '/sw-dem/ign-fetcher.js',
  '/sw-dem/mapbox.js',
  '/sw-dem/build-tile.js',
  '/sw-dem/composite.js',
  '/sw-dem/ortho.js',
  '/sw-dem/slope.js',
);

// Shared mutable state (used by sub-modules via global scope)
let mapboxToken = '';

// Composite concurrency limiter — caps peak memory from simultaneous blends
const COMPOSITE_MAX_CONCURRENT = 2;
let _compositeActive = 0;
const _compositeQueue = [];
function acquireComposite() {
  if (_compositeActive < COMPOSITE_MAX_CONCURRENT) {
    _compositeActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _compositeQueue.push(resolve));
}
function releaseComposite() {
  _compositeActive--;
  if (_compositeQueue.length > 0) {
    _compositeActive++;
    _compositeQueue.shift()();
  }
}

// ---------------------------------------------------------------------------
// SW Lifecycle
// ---------------------------------------------------------------------------

// Cache versions we want to purge on activation. Any old/stale name lands here.
const OLD_CACHES = [
  'dem-tiles-v1', 'dem-tiles-v2', 'dem-tiles-v3', 'dem-tiles-v4',
  'dem-tiles-v5', 'dem-tiles-v6', 'dem-tiles-v7', 'dem-tiles-v8',
  'dem-tiles-v9', 'dem-tiles-v10', 'dem-tiles-v11', 'dem-tiles-v12',
  'dem-tiles-v13', 'dem-tiles-v14', 'dem-tiles-v15', 'dem-tiles-v16',
  'dem-negative-v1', 'dem-negative-v2', 'dem-negative-v3',
  'dem-negative-v4', 'dem-negative-v5', 'dem-negative-v6',
  'dem-negative-v7', 'dem-negative-v8', 'dem-negative-v9',
  'dem-negative-v10',
  'ortho-tiles-v1', 'ortho-tiles-v2',
  'slope-tiles-v1', 'slope-tiles-v2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then((cache) => cache.add('/france-border.json'))
      .then(() => ensureFrancePoly())
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => OLD_CACHES.includes(k)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Ask any pre-existing clients to (re)send the token. New clients will
        // send it on their own boot sequence; this covers the SW-update case.
        return self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'REQUEST_TOKEN' }));
        });
      })
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SET_MAPBOX_TOKEN') {
    mapboxToken = e.data.token || '';
    if (DEBUG) console.log('[sw-dem] TOKEN SET');
    if (e.source) e.source.postMessage({ type: 'TOKEN_ACK' });
    return;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    caches.delete(SLOPE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_NEGATIVE_CACHE') {
    caches.delete(NEGATIVE_CACHE_NAME);
    return;
  }
});

// ---------------------------------------------------------------------------
// Fetch intercept
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  const demMatch = url.pathname.match(/^\/dem-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (demMatch) {
    event.respondWith(handleDemRequest(
      event.request,
      parseInt(demMatch[1], 10),
      parseInt(demMatch[2], 10),
      parseInt(demMatch[3], 10),
    ));
    return;
  }

  const orthoMatch = url.pathname.match(/^\/ortho-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (orthoMatch) {
    event.respondWith(handleOrthoRequest(
      parseInt(orthoMatch[1], 10),
      parseInt(orthoMatch[2], 10),
      parseInt(orthoMatch[3], 10),
    ));
    return;
  }

  const slopeMatch = url.pathname.match(/^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (slopeMatch) {
    const slopeMode = url.searchParams.get('mode') || 'gradient';
    event.respondWith(handleSlopeRequest(
      parseInt(slopeMatch[1], 10),
      parseInt(slopeMatch[2], 10),
      parseInt(slopeMatch[3], 10),
      slopeMode,
    ));
    return;
  }
});

// ---------------------------------------------------------------------------
// DEM request handler
// ---------------------------------------------------------------------------

function buildDemResponse(pngBlob, demSource) {
  return new Response(pngBlob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
      'X-DEM-Source': demSource,
    },
  });
}

// 204 No Content: the canonical "no tile here" signal for Mapbox GL raster-dem.
// Mapbox reuses the parent tile mesh instead of rendering a hole. This is
// exactly how plain Mapbox behaves when its own DEM tiles are missing.
function noTileResponse(reason) {
  return new Response(null, {
    status: 204,
    headers: { 'X-DEM-Reason': reason },
  });
}

async function tryParentOverzoom(cache, z, x, y, depth) {
  if (depth > 0) return null;
  const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
  for (let pZ = z - 1; pZ >= minParentZ; pZ--) {
    const pX = x >> (z - pZ);
    const pY = y >> (z - pZ);
    const parentKey = new Request(`/dem-tiles/${pZ}/${pX}/${pY}`);

    let parentResp = await cache.match(parentKey);
    if (!parentResp || parentResp.status !== 200) {
      parentResp = await handleDemRequest(parentKey, pZ, pX, pY, depth + 1);
    }
    if (!parentResp || parentResp.status !== 200) continue;

    try {
      const parentBlob = await parentResp.clone().blob();
      const overzoomed = await overzoomDemTile(parentBlob, pZ, pX, pY, z, x, y);
      if (overzoomed) {
        return { blob: overzoomed, source: `overzoom-z${pZ}` };
      }
    } catch (err) {
      if (DEBUG) console.warn(`[sw-dem] overzoom failed ${pZ}/${pX}/${pY}`, err);
    }
  }
  return null;
}

async function handleDemRequest(_request, z, x, y, _depth) {
  if (_depth === undefined) _depth = 0;
  const t0 = performance.now();
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`/dem-tiles/${z}/${x}/${y}`);

  // 1. Positive cache
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 2. Negative cache (TTL-bounded)
  const negCache = await caches.open(NEGATIVE_CACHE_NAME);
  const negCached = await negCache.match(cacheKey);
  if (negCached) {
    const age = parseInt(negCached.headers.get('x-cached-at') || '0', 10);
    const ttl = parseInt(negCached.headers.get('x-neg-ttl') || String(NEGATIVE_TTL_PIPELINE), 10);
    if (age && (Date.now() - age) < ttl * 1000) {
      // Try overzoom once, else honour the negative cache
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source);
      return noTileResponse('neg-cache');
    }
    negCache.delete(cacheKey);
  }

  const inFrance = tileOverlapsFrance(z, x, y);

  try {
    let pngBlob;
    let demSource = 'none';

    // 3. IGN France pipeline — only at zooms where LiDAR HD detail is visible.
    // Below IGN_BUILD_MINZOOM we serve Mapbox directly: LiDAR detail would be
    // imperceptible at that pixel density and the build jams the IGN queue.
    if (inFrance && z >= IGN_BUILD_MINZOOM) {
      await ensureFrancePoly();
      const tileClass = classifyDemTile(z, x, y);
      if (tileClass !== 'outside') {
        const ignResult = await buildIGNTile(z, x, y, tileClass);
        if (ignResult) {
          if (ignResult.blob) {
            pngBlob = ignResult.blob;
            demSource = ignResult.source || 'ign';
          } else {
            await acquireComposite();
            try {
              pngBlob = await compositeIGNMapbox(ignResult.elevations, ignResult.coverage, z, x, y);
            } finally {
              releaseComposite();
            }
            demSource = 'ign-composite';
          }
        }
      }
    }

    // 4. Mapbox global fallback
    if (!pngBlob && mapboxToken) {
      pngBlob = await fetchMapboxTile(z, x, y);
      if (pngBlob) demSource = 'mapbox';
    }

    // 5. Single-step parent overzoom
    if (!pngBlob) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source;
      }
    }

    // 6. Nothing worked — 204 with short TTL for transient failures, long for
    //    confirmed empty (outside France, no Mapbox token, etc.)
    if (!pngBlob) {
      const isConfirmedEmpty = !inFrance || !mapboxToken;
      const ttl = isConfirmedEmpty ? NEGATIVE_TTL_CONFIRMED : NEGATIVE_TTL_PIPELINE;
      const reason = !mapboxToken ? 'no-token' : (inFrance ? 'pipeline-error' : 'no-coverage');
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: {
          'x-cached-at': String(Date.now()),
          'x-neg-ttl': String(ttl),
        },
      }));
      if (DEBUG) {
        const dt = (performance.now() - t0).toFixed(0);
        console.warn(`[sw-dem] 204 ${z}/${x}/${y} reason=${reason} ttl=${ttl}s ${dt}ms`);
      }
      return noTileResponse(reason);
    }

    return finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource);
  } catch (err) {
    console.error('[sw-dem] error', z, x, y, err);
    const fb = await tryParentOverzoom(cache, z, x, y, _depth);
    if (fb) return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source);
    return noTileResponse('error');
  }
}

async function finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource) {
  const response = buildDemResponse(pngBlob, demSource);
  cache.put(cacheKey, response.clone());
  if (DEBUG) {
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[sw-dem] ${demSource} ${z}/${x}/${y} ${dt}ms`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Slope request handler (unchanged behaviour — relies on DEM cache)
// ---------------------------------------------------------------------------

// Minimal 1×1 transparent PNG used as a safe fallback when DEM data is absent.
const TRANSPARENT_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg=='
), (c) => c.charCodeAt(0));

function transparentTileResponse() {
  return new Response(TRANSPARENT_PNG.slice(), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

async function handleSlopeRequest(z, x, y, colorMode) {
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const cacheKey = new Request(`/slope-tiles/${z}/${x}/${y}?mode=${colorMode}`);
  const cached = await slopeCache.match(cacheKey);
  if (cached) return cached;

  const demCache = await caches.open(CACHE_NAME);
  const demKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
  let demResponse = await demCache.match(demKey);
  if (!demResponse || demResponse.status !== 200) {
    demResponse = await handleDemRequest(demKey, z, x, y);
  }
  if (!demResponse || demResponse.status !== 200) {
    // Do not cache transient failures
    return transparentTileResponse();
  }

  try {
    const demBlob = await demResponse.clone().blob();
    const slopeBlob = await buildSlopeTile(demBlob, z, x, y, colorMode);
    const response = new Response(slopeBlob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800',
        'X-Tile-Type': 'slope',
      },
    });
    slopeCache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    console.error('[slope]', z, x, y, err);
    return transparentTileResponse();
  }
}
