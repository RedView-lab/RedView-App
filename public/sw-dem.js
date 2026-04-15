// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho tile processor
// Entry point — loads sub-modules via importScripts()
//
// Sub-modules (in public/sw-dem/):
//   config.js        — constants & configuration
//   geo.js           — coordinate conversions, France bounds check
//   interpolation.js — BIL decoder, NODATA-aware bicubic/bilinear sampling
//   terrain-rgb.js   — Terrain-RGB PNG encode/decode
//   ign-fetcher.js   — IGN tile fetching with LRU cache + concurrency limiter
//   mapbox.js        — Mapbox DEM tile fetching
//   build-tile.js    — buildIGNTile (Mercator ← WGS84G resampling + dilation)
//   composite.js     — compositeIGNMapbox (distance transform + IDW + blend)
//   ortho.js         — Orthophoto tiles (France polygon, masking, handler)
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

// ---------------------------------------------------------------------------
// SW Lifecycle
// ---------------------------------------------------------------------------

// List of all cache versions to purge on activation
const OLD_CACHES = [
  'dem-tiles-v1', 'dem-tiles-v2', 'dem-tiles-v3',
  'dem-tiles-v4', 'dem-tiles-v5', 'dem-tiles-v6',
  'dem-tiles-v7', 'dem-tiles-v8', 'dem-tiles-v9',
  'dem-tiles-v10',
  'dem-negative-v1', 'dem-negative-v2', 'dem-negative-v3',
  'slope-tiles-v1',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => cache.add('/france-border.json'))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => OLD_CACHES.includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SET_MAPBOX_TOKEN') {
    mapboxToken = e.data.token;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    caches.delete(SLOPE_CACHE_NAME).then(() => {
      console.log('[slope] %c SLOPE CACHE CLEARED %c via message', 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
    });
  }
});

// ---------------------------------------------------------------------------
// Fetch intercept
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  const demMatch = url.pathname.match(/^\/dem-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (demMatch) {
    event.respondWith(handleDemRequest(event.request,
      parseInt(demMatch[1], 10), parseInt(demMatch[2], 10), parseInt(demMatch[3], 10)));
    return;
  }

  const orthoMatch = url.pathname.match(/^\/ortho-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (orthoMatch) {
    event.respondWith(handleOrthoRequest(
      parseInt(orthoMatch[1], 10), parseInt(orthoMatch[2], 10), parseInt(orthoMatch[3], 10)));
    return;
  }

  const slopeMatch = url.pathname.match(/^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (slopeMatch) {
    event.respondWith(handleSlopeRequest(
      parseInt(slopeMatch[1], 10), parseInt(slopeMatch[2], 10), parseInt(slopeMatch[3], 10)));
    return;
  }
});

// ---------------------------------------------------------------------------
// DEM request handler
// ---------------------------------------------------------------------------

async function handleDemRequest(request, z, x, y) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const negCache = await caches.open(NEGATIVE_CACHE_NAME);
  const negCached = await negCache.match(cacheKey);
  if (negCached) {
    const age = negCached.headers.get('x-cached-at');
    if (age && (Date.now() - parseInt(age, 10)) < NEGATIVE_TTL * 1000) {
      return new Response(null, { status: 204 });
    }
    negCache.delete(cacheKey);
  }

  try {
    let pngBlob;
    let demSource = 'none';

    if (tileOverlapsFrance(z, x, y) && z >= IGN_DEM_MINZOOM) {
      const ignResult = await buildIGNTile(z, x, y);

      if (ignResult) {
        if (ignResult.blob) {
          pngBlob = ignResult.blob;
          demSource = ignResult.source || 'ign-full';
        } else {
          pngBlob = await compositeIGNMapbox(ignResult.elevations, ignResult.coverage, z, x, y);
          demSource = `composite(${ignResult.source || 'ign-partial'})`;
        }
      }
    }

    if (!pngBlob && mapboxToken) {
      pngBlob = await fetchMapboxTile(z, x, y);
      if (pngBlob) demSource = 'mapbox';
    }

    if (!pngBlob) {
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: { 'x-cached-at': String(Date.now()) },
      }));
      return new Response(null, { status: 204 });
    }

    if (demSource.includes('fallback')) {
      console.warn(`[sw-dem] ${z}/${x}/${y} used ${demSource}`);
    }

    const response = new Response(pngBlob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800',
        'X-DEM-Source': demSource,
      },
    });

    cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    console.error('[sw-dem] Error processing tile', z, x, y, err);
    return new Response(null, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Slope helpers
// ---------------------------------------------------------------------------

// Minimal 1×1 transparent PNG (68 bytes) returned when no DEM data is available.
// Mapbox can decode this without error and renders nothing.
const TRANSPARENT_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

function transparentTileResponse() {
  return new Response(TRANSPARENT_PNG.slice(), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

// ---------------------------------------------------------------------------
// Slope request handler
// ---------------------------------------------------------------------------

async function handleSlopeRequest(z, x, y) {
  const t0 = performance.now();
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const cacheKey = new Request(`/slope-tiles/${z}/${x}/${y}`);
  const cached = await slopeCache.match(cacheKey);
  if (cached) {
    console.log(`[slope] %c CACHE HIT %c ${z}/${x}/${y}`, 'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '');
    return cached;
  }
  console.log(`[slope] %c CACHE MISS %c ${z}/${x}/${y} — building fresh`, 'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', '');

  // Fetch the DEM tile (may come from DEM cache or be freshly built)
  const demCache = await caches.open(CACHE_NAME);
  const demKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
  let demResponse = await demCache.match(demKey);
  const demFromCache = !!demResponse;

  if (!demResponse || demResponse.status !== 200) {
    // Trigger DEM generation by calling handleDemRequest
    console.log(`[slope] ${z}/${x}/${y} — DEM not in cache, triggering handleDemRequest`);
    demResponse = await handleDemRequest(demKey, z, x, y);
  }

  if (!demResponse || demResponse.status !== 200) {
    // Return a transparent 1×1 PNG so Mapbox can decode it without error
    console.warn(`[slope] %c NO DEM %c ${z}/${x}/${y} — demResponse status=${demResponse?.status}, returning transparent`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
    return transparentTileResponse();
  }

  const demSource = demResponse.headers.get('X-DEM-Source') || 'unknown';
  console.log(`[slope] ${z}/${x}/${y} — DEM source: ${demSource}, fromCache: ${demFromCache}`);

  try {
    const demBlob = await demResponse.clone().blob();
    console.log(`[slope] ${z}/${x}/${y} — DEM blob size: ${demBlob.size} bytes`);
    const slopeBlob = await buildSlopeTile(demBlob, z, x, y);
    const dt = (performance.now() - t0).toFixed(1);
    console.log(`[slope] ${z}/${x}/${y} — slope blob size: ${slopeBlob.size} bytes, total: ${dt}ms`);

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
    console.error(`[slope] %c ERROR %c ${z}/${x}/${y}`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '', err);
    return transparentTileResponse();
  }
}
