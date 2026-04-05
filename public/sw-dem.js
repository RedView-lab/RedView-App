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
  'dem-negative-v1',
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

    if (tileOverlapsFrance(z, x, y) && z >= IGN_DEM_MINZOOM) {
      const ignResult = await buildIGNTile(z, x, y);

      if (ignResult) {
        if (ignResult.blob) {
          pngBlob = ignResult.blob;
        } else {
          pngBlob = await compositeIGNMapbox(ignResult.elevations, ignResult.coverage, z, x, y);
        }
      }
    }

    if (!pngBlob && mapboxToken) {
      pngBlob = await fetchMapboxTile(z, x, y);
    }

    if (!pngBlob) {
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: { 'x-cached-at': String(Date.now()) },
      }));
      return new Response(null, { status: 204 });
    }

    const response = new Response(pngBlob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=604800',
      },
    });

    cache.put(cacheKey, response.clone());
    return response;
  } catch (err) {
    console.error('[sw-dem] Error processing tile', z, x, y, err);
    return new Response(null, { status: 500 });
  }
}
