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

// Composite concurrency limiter — caps peak memory from simultaneous blends.
// Raised from 2 → 6: compositeIGNMapbox uses ≤2 MB per call (2× Float32(256²)
// + a 512² Mapbox elev array) so 6 concurrent ≈ 12 MB — trivial. With 2 we
// bottlenecked every zoom-in: a 20-tile viewport queued 10 composite cycles
// of 300–500 ms each = 5 s wall-clock of pipeline pressure, causing
// soft-deadline overflow downstream.
const COMPOSITE_MAX_CONCURRENT = 6;
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
  'dem-tiles-v17', 'dem-tiles-v18', 'dem-tiles-v19', 'dem-tiles-v20',
  'dem-tiles-v21', 'dem-tiles-v22', 'dem-tiles-v23', 'dem-tiles-v24',
  'dem-tiles-v25', 'dem-tiles-v26',
  'dem-negative-v1', 'dem-negative-v2', 'dem-negative-v3',
  'dem-negative-v4', 'dem-negative-v5', 'dem-negative-v6',
  'dem-negative-v7', 'dem-negative-v8', 'dem-negative-v9',
  'dem-negative-v10', 'dem-negative-v11', 'dem-negative-v12',
  'dem-negative-v13', 'dem-negative-v14', 'dem-negative-v15',
  'dem-negative-v16',
  'dem-negative-v17',
  'dem-negative-v18',
  'dem-negative-v19',
  'dem-negative-v20',
  'ortho-tiles-v1', 'ortho-tiles-v2', 'ortho-tiles-v3', 'ortho-tiles-v4',
  'ortho-tiles-v5', 'ortho-tiles-v6', 'ortho-tiles-v7', 'ortho-tiles-v8',
  'slope-tiles-v1', 'slope-tiles-v2', 'slope-tiles-v3',
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

  // World-zoom short-circuit: no visible terrain relief below z4, and at that
  // zoom Mapbox tiles are tiny fractions of the globe. Returning 204 instantly
  // lets Mapbox GL reuse parent/empty meshes and prevents the SW from ever
  // blocking the Standard-Satellite base-map fetches on origin contention
  // during fast pinch-zoom-out (root cause of the "white earth" symptom).
  if (z < 4) return noTileResponse('world-zoom');

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

    // 3. IGN France pipeline — gated by pixel-density, not a hardcoded zoom.
    // shouldUseIGN(z, lat) returns true when the rendered pixel is smaller
    // than Mapbox's ~30 m native sample distance, so we invest IGN cost only
    // where LiDAR detail is actually visible. Latitude-aware: handles Corsica
    // (low lat, earlier crossover) and Dunkirk (high lat, later crossover)
    // with the same continuous function instead of a magic-number zoom.
    let upgradePending = null; // in-flight IGN sub-tile fetches for background re-cache
    const tileBounds = mercatorTileBounds(z, x, y);
    const tileCenterLat = (tileBounds.north + tileBounds.south) / 2;
    if (inFrance && shouldUseIGN(z, tileCenterLat)) {
      const polyOk = await ensureFrancePoly();
      if (polyOk) {
        const tileClass = classifyDemTile(z, x, y);
        if (tileClass !== 'outside') {
          const ignResult = await buildIGNTile(z, x, y, tileClass);
          if (ignResult) {
            // 0-coverage placeholder: sub-tiles still in flight — capture
            // pendingFetches so the background upgrade can rebuild the tile
            // once they land, even though we have nothing to serve now.
            // Fall through to Mapbox/overzoom for the immediate response.
            if (ignResult.emptyPending) {
              upgradePending = ignResult.pendingFetches;
            } else if (ignResult.blob) {
              pngBlob = ignResult.blob;
              demSource = ignResult.source || 'ign';
              upgradePending = ignResult.pendingFetches;
            } else {
              await acquireComposite();
              try {
                pngBlob = await compositeIGNMapbox(ignResult.elevations, ignResult.coverage, z, x, y);
              } finally {
                releaseComposite();
              }
              demSource = 'ign-composite';
              upgradePending = ignResult.pendingFetches;
            }
          }
        }
      }
      // If polyOk is false we deliberately fall through to the Mapbox branch
      // below — running IGN without the polygon would misclassify every tile.
    }

    // 3b. High-zoom-in-France LiDAR-preserving fallback.
    //
    // Problem we are solving: when IGN fails transiently on a single tile
    // inside France at mercZ > MAPBOX_DEM_MAXZOOM (queue prune, LiDAR-HD
    // nodata pocket, 10 s timeout) the legacy step 4 below would call
    // fetchMapboxTile(), which clamps to z14 and server-overzooms a flat
    // 30 m tile up to z15/16/17. That blob is geometrically smooth but
    // elevationally flat — EXACTLY the "je perds tout, 30 m en zoom-in"
    // symptom — and then it gets positive-cached for 1 week with
    // X-DEM-Source: mapbox, so the bad tile persists long after IGN
    // recovers.
    //
    // At this zoom the only admissible fallback is our OWN cache: mid-zoom
    // parent tiles (z ≤ 14) in France are already LiDAR-HD composites.
    // Bicubic-overzooming a z14 LiDAR tile to z17 preserves real relief
    // (rocks, ridgelines, couloirs) — infinitely better than stretching a
    // 30 m Mapbox pixel. If no LiDAR parent is available either, we return
    // 204 with a very short TTL so Mapbox GL falls back to its own cached
    // parent mesh (which is again the LiDAR blob one zoom level up) and
    // retries the IGN pipeline on the next pan/zoom.
    if (!pngBlob && inFrance && z > MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-lidar-parent';
      }
    }

    // 4. Mapbox global fallback — only at low zoom or outside France.
    // Inside France at mercZ > MAPBOX_DEM_MAXZOOM we deliberately skip this:
    // Mapbox Terrain-DEM is already overzoomed server-side there (flat 30 m)
    // and masking that as "detail" actively degrades the mesh vs the LiDAR
    // parent-overzoom path above.
    const skipMapboxHighZoomInFrance = inFrance && z > MAPBOX_DEM_MAXZOOM;
    if (!pngBlob && mapboxToken && !skipMapboxHighZoomInFrance) {
      pngBlob = await fetchMapboxTile(z, x, y);
      if (pngBlob) demSource = 'mapbox';
    }

    // 5. Single-step parent overzoom (outside-France & low-zoom path).
    //    In-France high-zoom already tried parent-overzoom at step 3b.
    if (!pngBlob && !skipMapboxHighZoomInFrance) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source;
      }
    }

    // 6. Nothing worked — 204 with short TTL for transient failures, long for
    //    confirmed empty (outside France, no Mapbox token, etc.)
    if (!pngBlob) {
      // If IGN sub-tiles are still in flight, skip negative caching AND
      // schedule the background upgrade so the next request picks up LiDAR
      // instead of the stale 204. Without this, a user who stops panning in
      // France at z=14 sees perma-Mapbox-flat because the 60 s neg-cache TTL
      // keeps serving 204 → Mapbox GL uses parent tile → never requests
      // again → upgrade never runs.
      if (upgradePending && upgradePending.length) {
        scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending);
        if (DEBUG) {
          const dt = (performance.now() - t0).toFixed(0);
          console.log(`[sw-dem] 204+upgrade ${z}/${x}/${y} — sub-tiles in flight, ${dt}ms`);
        }
        return noTileResponse('ign-pending');
      }
      const isConfirmedEmpty = !inFrance || !mapboxToken;
      const ttl = isConfirmedEmpty ? NEGATIVE_TTL_CONFIRMED : NEGATIVE_TTL_PIPELINE;
      const reason = !mapboxToken
        ? 'no-token'
        : (skipMapboxHighZoomInFrance ? 'ign-pending-highzoom' : (inFrance ? 'pipeline-error' : 'no-coverage'));
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

    return finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource, upgradePending);
  } catch (err) {
    console.error('[sw-dem] error', z, x, y, err);
    const fb = await tryParentOverzoom(cache, z, x, y, _depth);
    if (fb) return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source);
    return noTileResponse('error');
  }
}

async function finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource, upgradePending) {
  const response = buildDemResponse(pngBlob, demSource);
  cache.put(cacheKey, response.clone());
  if (DEBUG) {
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[sw-dem] ${demSource} ${z}/${x}/${y} ${dt}ms`);
  }
  // Fire-and-forget: if IGN sub-tiles were still in flight at the soft
  // deadline, let them finish in the background and replace the cached blob
  // with a full-quality IGN build. Next time Mapbox requests this tile
  // (natural tile-cache cycling while panning/zooming) it gets best quality.
  if (upgradePending && upgradePending.length) {
    scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending);
  }
  return response;
}

// Coalesce concurrent upgrade jobs for the same tile.
const pendingUpgrades = new Set();

function scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, fetches) {
  const key = `${z}/${x}/${y}`;
  if (pendingUpgrades.has(key)) return;
  pendingUpgrades.add(key);

  (async () => {
    try {
      await Promise.allSettled(fetches);
      // Skip if a concurrent request already upgraded this tile.
      const existing = await cache.match(cacheKey);
      if (existing) {
        const src = existing.headers.get('X-DEM-Source') || '';
        if (src.endsWith('+upgrade') || src === 'ign' || src.startsWith('ign-fallback-z')) {
          // Already full-quality — nothing to gain.
          return;
        }
      }
      // All sub-tiles are now in the IGN memory cache (either as data or as
      // cached-null with TTL). Rebuild — second pass is near-free.
      const tileClass = classifyDemTile(z, x, y);
      if (tileClass === 'outside') return;
      const ignResult = await buildIGNTile(z, x, y, tileClass);
      if (!ignResult) return;

      let upgradedBlob = ignResult.blob;
      let upgradedSource = ignResult.source || 'ign';
      if (!upgradedBlob) {
        await acquireComposite();
        try {
          upgradedBlob = await compositeIGNMapbox(
            ignResult.elevations, ignResult.coverage, z, x, y,
          );
        } finally {
          releaseComposite();
        }
        upgradedSource = 'ign-composite';
      }
      if (!upgradedBlob) return;

      await cache.put(cacheKey, buildDemResponse(upgradedBlob, upgradedSource + '+upgrade'));
      if (DEBUG) console.log(`[sw-dem][upgrade] ${z}/${x}/${y} re-cached at ${upgradedSource}`);
      // Notify all open clients so Mapbox GL can refresh the DEM source and
      // pick up the fresh LiDAR blob from CacheStorage. Without this message,
      // a stationary user sees the original (Mapbox or dilated partial)
      // tile forever — the cache is upgraded but Mapbox GL never re-reads
      // the HTTP endpoint until the viewport changes.
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const c of clients) c.postMessage({ type: 'DEM_TILE_UPGRADED', z, x, y });
      } catch { /* client iteration best-effort */ }
    } catch (e) {
      if (DEBUG) console.warn(`[sw-dem][upgrade] ${z}/${x}/${y} failed`, e);
    } finally {
      pendingUpgrades.delete(key);
    }
  })();
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
    const slopeBlob = await buildSlopeTile(demBlob, z, x, y, colorMode, demCache);
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
