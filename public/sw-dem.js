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
let _tokenRecoveryInFlight = false;

// ---------------------------------------------------------------------------
// Token persistence — survives SW termination/restart
// ---------------------------------------------------------------------------
const TOKEN_CACHE_KEY = '/internal/mapbox-token';

async function persistToken(token) {
  try {
    const cache = await caches.open(STATIC_CACHE_NAME);
    await cache.put(TOKEN_CACHE_KEY, new Response(token, {
      headers: { 'Content-Type': 'text/plain', 'x-stored-at': String(Date.now()) },
    }));
  } catch (e) {
    console.warn('[sw-dem] Failed to persist token:', e);
  }
}

async function loadPersistedToken() {
  try {
    const cache = await caches.open(STATIC_CACHE_NAME);
    const resp = await cache.match(TOKEN_CACHE_KEY);
    if (resp) {
      const token = await resp.text();
      if (token && token.length > 10) return token;
    }
  } catch (e) {
    console.warn('[sw-dem] Failed to load persisted token:', e);
  }
  return null;
}

// Try to recover the token from CacheStorage + request from clients as last resort.
// Sets mapboxToken and returns true if recovered, false otherwise.
async function ensureToken() {
  if (mapboxToken) return true;
  if (_tokenRecoveryInFlight) return false;
  _tokenRecoveryInFlight = true;
  try {
    const cached = await loadPersistedToken();
    if (cached) {
      mapboxToken = cached;
      console.log('[sw-dem] %c TOKEN RECOVERED %c from CacheStorage', 'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '');
      // Notify all clients so they can reload stale DEM tiles
      const clients = await self.clients.matchAll();
      for (const client of clients) {
        client.postMessage({ type: 'TOKEN_RECOVERED' });
      }
      return true;
    }
    // Last resort: ask clients to resend the token
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: 'REQUEST_TOKEN' });
    }
    // Give client 500ms to respond before giving up for this request
    await new Promise(r => setTimeout(r, 500));
    return !!mapboxToken;
  } finally {
    _tokenRecoveryInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// SW Lifecycle
// ---------------------------------------------------------------------------

// List of all cache versions to purge on activation
const OLD_CACHES = [
  'dem-tiles-v1', 'dem-tiles-v2', 'dem-tiles-v3',
  'dem-tiles-v4', 'dem-tiles-v5', 'dem-tiles-v6',
  'dem-tiles-v7', 'dem-tiles-v8', 'dem-tiles-v9',
  'dem-tiles-v10', 'dem-tiles-v11',
  'dem-negative-v1', 'dem-negative-v2', 'dem-negative-v3',
  'dem-negative-v4', 'dem-negative-v5',
  'ortho-tiles-v1',
  'slope-tiles-v1', 'slope-tiles-v2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => cache.add('/france-border.json'))
      // Pre-warm France polygon so first tile requests don't block on it
      .then(() => ensureFrancePoly())
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
    )
    .then(() => loadPersistedToken())
    .then(token => {
      if (token) {
        mapboxToken = token;
        console.log('[sw-dem] %c TOKEN RESTORED %c on activate from CacheStorage', 'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '');
      }
    })
    .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SET_MAPBOX_TOKEN') {
    mapboxToken = e.data.token;
    persistToken(e.data.token); // Survive SW restart
    console.log('[sw-dem] %c TOKEN SET %c mapboxToken received & persisted', 'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '');

    // Flush negative cache so tiles that failed before the token arrived are retried
    caches.delete(NEGATIVE_CACHE_NAME).then(() => {
      console.log('[sw-dem] %c NEG-CACHE FLUSHED %c on token arrival — tiles will be retried', 'background:#2196F3;color:#fff;padding:2px 4px;border-radius:2px', '');
    });

    // Acknowledge receipt so the main thread knows it's safe to add sources
    if (e.source) {
      e.source.postMessage({ type: 'TOKEN_ACK' });
    }
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    caches.delete(SLOPE_CACHE_NAME).then(() => {
      console.log('[slope] %c SLOPE CACHE CLEARED %c via message', 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
    });
  }
  if (e.data?.type === 'CLEAR_NEGATIVE_CACHE') {
    caches.delete(NEGATIVE_CACHE_NAME).then(() => {
      console.log('[sw-dem] %c NEG-CACHE CLEARED %c via message', 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
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
    const slopeMode = url.searchParams.get('mode') || 'gradient';
    event.respondWith(handleSlopeRequest(
      parseInt(slopeMatch[1], 10), parseInt(slopeMatch[2], 10), parseInt(slopeMatch[3], 10), slopeMode));
    return;
  }
});

// ---------------------------------------------------------------------------
// DEM request handler
// ---------------------------------------------------------------------------

// Returns a valid 200 response with a flat sea-level DEM tile.
// Mapbox GL JS needs a valid terrain mesh for every tile area — otherwise
// satellite imagery cannot be draped and the area renders as WHITE.
async function flatDemResponse() {
  const flatBlob = await getFlatDemTile();
  return new Response(flatBlob.slice(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'X-DEM-Source': 'flat-fallback',
    },
  });
}

async function handleDemRequest(request, z, x, y, _depth) {
  if (_depth === undefined) _depth = 0;
  const t0 = performance.now();
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const negCache = await caches.open(NEGATIVE_CACHE_NAME);
  const negCached = await negCache.match(cacheKey);
  if (negCached) {
    const age = negCached.headers.get('x-cached-at');
    const negTtl = parseInt(negCached.headers.get('x-neg-ttl') || String(NEGATIVE_TTL_PIPELINE), 10);
    if (age && (Date.now() - parseInt(age, 10)) < negTtl * 1000) {
      const ageSec = ((Date.now() - parseInt(age, 10)) / 1000).toFixed(0);
      console.log(`[sw-dem][neg-cache] HIT ${z}/${x}/${y} age=${ageSec}s ttl=${negTtl}s`);
      return flatDemResponse();
    }
    negCache.delete(cacheKey);
  }

  // Recover token from persistent storage if SW was restarted
  if (!mapboxToken) {
    await ensureToken();
  }

  try {
    let pngBlob;
    let demSource = 'none';

    if (tileOverlapsFrance(z, x, y) && z >= IGN_DEM_MINZOOM) {
      // Use polygon classification to avoid fetching IGN for tiles outside France
      await ensureFrancePoly();
      const tileClass = classifyDemTile(z, x, y);

      if (tileClass !== 'outside') {
        const ignResult = await buildIGNTile(z, x, y, tileClass);

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
    }

    if (!pngBlob && mapboxToken) {
      pngBlob = await fetchMapboxTile(z, x, y);
      if (pngBlob) demSource = 'mapbox';
    }

    if (!pngBlob && !mapboxToken) {
      console.warn(`[sw-dem] ${z}/${x}/${y} — no mapboxToken available, cannot fall back to Mapbox`);
    }

    // ③ Overzoom: fetch a lower-zoom DEM and upsample (only at top-level)
    if (!pngBlob && _depth === 0) {
      const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
      for (let pZ = z - 1; pZ >= minParentZ; pZ--) {
        const pX = x >> (z - pZ);
        const pY = y >> (z - pZ);
        const parentKey = new Request(`/dem-tiles/${pZ}/${pX}/${pY}`);

        // Try cache first, then generate parent (with _depth=1 to prevent recursion)
        let parentResp = await cache.match(parentKey);
        if (!parentResp || parentResp.status !== 200) {
          parentResp = await handleDemRequest(parentKey, pZ, pX, pY, _depth + 1);
        }

        if (parentResp && parentResp.status === 200) {
          try {
            const parentBlob = await parentResp.clone().blob();
            pngBlob = await overzoomDemTile(parentBlob, pZ, pX, pY, z, x, y);
            if (pngBlob) {
              demSource = `overzoom-z${pZ}`;
              break;
            }
          } catch (ozErr) {
            console.warn(`[sw-dem] overzoom failed ${pZ}/${pX}/${pY} → ${z}/${x}/${y}`, ozErr);
          }
        }
      }
    }

    if (!pngBlob) {
      const dt = (performance.now() - t0).toFixed(1);

      // Do NOT negative-cache if the Mapbox token hasn't been delivered yet —
      // the failure is guaranteed to be transient and caching it would lock out
      // the tile for up to 1 hour.
      if (!mapboxToken) {
        console.warn(
          `[sw-dem] %c NO DATA (no token) %c ${z}/${x}/${y} — NOT caching, depth=${_depth}, ${dt}ms`,
          'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', ''
        );
        return flatDemResponse();
      }

      // Heuristic: if tile is outside France and Mapbox also failed → likely confirmed empty
      const isOutsideFrance = !tileOverlapsFrance(z, x, y);
      const negTtl = isOutsideFrance ? NEGATIVE_TTL_CONFIRMED : NEGATIVE_TTL_PIPELINE;

      console.warn(
        `[sw-dem] %c NO DATA %c ${z}/${x}/${y} — neg-cache ttl=${negTtl}s, depth=${_depth}, hasToken=${!!mapboxToken}, ${dt}ms`,
        'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', ''
      );

      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: {
          'x-cached-at': String(Date.now()),
          'x-neg-ttl': String(negTtl),
        },
      }));
      return flatDemResponse();
    }

    const dt = (performance.now() - t0).toFixed(1);
    if (demSource.includes('fallback') || dt > 2000) {
      console.warn(`[sw-dem] ${z}/${x}/${y} → ${demSource} (${dt}ms)`);
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
    return flatDemResponse();
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

async function handleSlopeRequest(z, x, y, colorMode) {
  const t0 = performance.now();
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const cacheKey = new Request(`/slope-tiles/${z}/${x}/${y}?mode=${colorMode}`);
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
    // Return a transparent 1×1 PNG so Mapbox can decode it without error.
    // Do NOT cache this transparent tile — the DEM failure may be transient
    // (token race, queue overflow). Caching would poison the slope cache for 7 days.
    console.warn(`[slope] %c NO DEM %c ${z}/${x}/${y} — demResponse status=${demResponse?.status}, returning transparent (NOT cached)`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
    return transparentTileResponse();
  }

  const demSource = demResponse.headers.get('X-DEM-Source') || 'unknown';
  console.log(`[slope] ${z}/${x}/${y} — DEM source: ${demSource}, fromCache: ${demFromCache}`);

  try {
    const demBlob = await demResponse.clone().blob();
    console.log(`[slope] ${z}/${x}/${y} — DEM blob size: ${demBlob.size} bytes`);
    const slopeBlob = await buildSlopeTile(demBlob, z, x, y, colorMode);
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
    // Do NOT cache error results — prevents slope cache poisoning from transient failures
    console.error(`[slope] %c ERROR %c ${z}/${x}/${y} (NOT cached)`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '', err);
    return transparentTileResponse();
  }
}
