// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho tile processor
// Entry point — loads sub-modules via importScripts()
//
// Contract with the page (useMap.ts):
//   1. page registers SW and waits for controllerchange
//   2. ONLY THEN does the page add /dem-tiles/ and /ortho-tiles/ sources
//
// Consequence: DEM fetches are entirely local/public-source driven
// (IGN/swissALTI/AWS Terrarium). We NEVER synthesize a fake "flat" elevation
// tile; on genuine misses we return 204 so the renderer can reuse parent mesh.
// ---------------------------------------------------------------------------

importScripts(
  '/sw-dem/config.js',
  '/sw-dem/geo.js',
  '/sw-dem/interpolation.js',
  '/sw-dem/terrain-rgb.js',
  '/sw-dem/ign-fetcher.js',
  '/sw-dem/mapbox.js',
  '/sw-dem/aws-terrain.js',
  '/sw-dem/build-tile.js',
  '/sw-dem/composite.js',
  '/sw-dem/ortho.js',
  '/sw-dem/slope.js',
  '/sw-dem/altitude.js',
  // Switzerland — swissSURFACE3D Raster (COG over STAC, 0.5 m LiDAR DSM)
  '/sw-dem/swiss-config.js',
  '/sw-dem/swiss-coords.js',
  '/sw-dem/swiss-cog.js',
  '/sw-dem/swiss-fetcher.js',
  '/sw-dem/swiss-build.js',
);

// Composite concurrency limiter — caps peak memory from simultaneous blends.
// Raised from 2 → 6: compositeIGNMapbox uses ≤2 MB per call (2× Float32(256²)
// + a 512² Mapbox elev array) so 6 concurrent ≈ 12 MB — trivial. With 2 we
// bottlenecked every zoom-in: a 20-tile viewport queued 10 composite cycles
// of 300–500 ms each = 5 s wall-clock of pipeline pressure, causing
// soft-deadline overflow downstream.
const COMPOSITE_MAX_CONCURRENT = 6;
let _compositeActive = 0;
const _compositeQueue = [];

// In-flight slope tile dedup: key = `${z}/${x}/${y}?${resFactor}` →
// Promise<Response>. Lets concurrent requests for the same tile share
// the single ongoing computation instead of duplicating the Horn pipeline.
const SLOPE_INFLIGHT = new Map();
const ALTITUDE_INFLIGHT = new Map();
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
  'dem-tiles-v25', 'dem-tiles-v26', 'dem-tiles-v27', 'dem-tiles-v28',
  'dem-tiles-v29',
  'dem-tiles-v30',
  'dem-tiles-v31',
  'dem-tiles-v32',
  'dem-tiles-v33',
  'dem-tiles-v34',
  'dem-tiles-v35',
  'dem-tiles-v36',
  'dem-tiles-v37',
  'dem-tiles-v38',
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
  'dem-negative-v21',
  'dem-negative-v22',
  'dem-negative-v23',
  'ortho-tiles-v1', 'ortho-tiles-v2', 'ortho-tiles-v3', 'ortho-tiles-v4',
  'ortho-tiles-v5', 'ortho-tiles-v6', 'ortho-tiles-v7', 'ortho-tiles-v8',
  'slope-tiles-v1', 'slope-tiles-v2', 'slope-tiles-v3', 'slope-tiles-v4', 'slope-tiles-v5', 'slope-tiles-v6', 'slope-tiles-v7',
  'shadow-tiles-v1',
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
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'CLEAR_DEM_CACHE') {
    caches.delete(CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    caches.delete(SLOPE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_ALTITUDE_CACHE') {
    caches.delete(ALTITUDE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SHADOW_CACHE') {
    // Retired endpoint — kept for compatibility with any in-flight client
    // build that still posts the message.
    caches.delete('shadow-tiles-v1');
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
    const slopeRes = url.searchParams.get('res') || '';
    event.respondWith(handleSlopeRequest(
      parseInt(slopeMatch[1], 10),
      parseInt(slopeMatch[2], 10),
      parseInt(slopeMatch[3], 10),
      slopeRes,
    ));
    return;
  }

  const altitudeMatch = url.pathname.match(/^\/altitude-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (altitudeMatch) {
    event.respondWith(handleAltitudeRequest(
      parseInt(altitudeMatch[1], 10),
      parseInt(altitudeMatch[2], 10),
      parseInt(altitudeMatch[3], 10),
    ));
    return;
  }

  const shadowMatch = url.pathname.match(/^\/shadow-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (shadowMatch) {
    // Legacy per-tile shadow endpoint — retired in favour of the in-page
    // ImageSource pipeline (src/features/sunlight). Return 410 so any stale
    // SW client requesting it doesn't trigger a build.
    event.respondWith(new Response(null, { status: 410, headers: { 'X-DEM-Reason': 'shadow-retired' } }));
    return;
  }
});

// ---------------------------------------------------------------------------
// DEM request handler
// ---------------------------------------------------------------------------

function buildDemResponse(pngBlob, demSource, shortCache, healthStatus = 'ok') {
  const cachedAt = Date.now();
  const shortTtlMs = shortCache ? 15_000 : 0;
  return new Response(pngBlob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // 30-day TTL on positive DEM tiles. Both AWS Terrarium and IGN/swiss
      // LiDAR DEM datasets are static reference data \u2014 keeping the SW cache
      // warm across sessions eliminates re-billing for previously visited
      // areas and is the single biggest lever on the Raster Tiles SKU.
      'Cache-Control': shortCache
        ? `public, max-age=${Math.max(1, Math.ceil(shortTtlMs / 1000))}`
        : 'public, max-age=2592000',
      'X-DEM-Source': demSource,
      'X-DEM-Health': healthStatus,
      'x-cached-at': String(cachedAt),
      ...(shortTtlMs > 0 ? { 'x-cache-ttl-ms': String(shortTtlMs) } : {}),
    },
  });
}

// 204 No Content: canonical "no tile here" signal for the terrain renderer.
// The renderer reuses the parent tile mesh instead of rendering a hole.
function noTileResponse(reason) {
  return new Response(null, {
    status: 204,
    headers: { 'X-DEM-Reason': reason },
  });
}

function isExpertFallbackRiskTile(z, x, y) {
  return z >= 12 && (tileOverlapsFrance(z, x, y) || tileOverlapsSwitzerland(z, x, y));
}

function shouldSkipUnsafeOverzoomParent(parentResp, z, x, y) {
  const parentShortTtlMs = parseInt(parentResp.headers.get('x-cache-ttl-ms') || '0', 10);
  const parentHealth = (parentResp.headers.get('X-DEM-Health') || 'ok').toLowerCase();
  if (parentHealth !== 'ok') return true;

  if (!isExpertFallbackRiskTile(z, x, y)) return false;

  if (parentShortTtlMs > 0) return true;

  const parentSource = (parentResp.headers.get('X-DEM-Source') || '').toLowerCase();
  if (!parentSource) return true;

  return parentSource.startsWith('aws-terrarium')
    || parentSource.startsWith('mapbox')
    || parentSource.startsWith('overzoom')
    || parentSource.includes('fastpath');
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

    const parentSource = parentResp.headers.get('X-DEM-Source') || 'unknown';
    if (shouldSkipUnsafeOverzoomParent(parentResp, z, x, y)) {
      if (DEBUG) {
        console.warn(
          `[sw-dem][expert-fallback] skip parent ${pZ}/${pX}/${pY} for ${z}/${x}/${y} src=${parentSource}`,
        );
      }
      continue;
    }

    try {
      const parentBlob = await parentResp.clone().blob();
      const overzoomed = await overzoomDemTile(parentBlob, pZ, pX, pY, z, x, y);
      if (overzoomed) {
        return { blob: overzoomed, source: `overzoom-z${pZ}:${parentSource}` };
      }
    } catch (err) {
      if (DEBUG) console.warn(`[sw-dem] overzoom failed ${pZ}/${pX}/${pY}`, err);
    }
  }
  return null;
}

const DEM_HEALTH_MIN_PARENT_RANGE_M = 40;
const DEM_HEALTH_MIN_COLLAPSED_RANGE_M = 4;
const DEM_HEALTH_MAX_MEAN_DELTA_M = 180;
const DEM_HEALTH_VERTICAL_OFFSET_M = 180;
const DEM_HEALTH_NODATA_MEAN_M = -8000;

function summarizeDemElevations(elevations) {
  if (!elevations?.length) {
    return {
      valid: false,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      range: Number.NaN,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < elevations.length; index += 1) {
    const value = elevations[index];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    count += 1;
  }

  if (count === 0) {
    return {
      valid: false,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      range: Number.NaN,
    };
  }

  return {
    valid: true,
    min,
    max,
    mean: sum / count,
    range: max - min,
  };
}

async function guardDemTileHealth(cache, pngBlob, z, x, y, demSource) {
  if (!pngBlob || z < 8) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  let currentElevations;
  try {
    currentElevations = await decodeTerrainRGBBlob(pngBlob);
  } catch (error) {
    console.warn(`[sw-dem][health] decode failed ${z}/${x}/${y} src=${demSource}`, error);
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'decode-failed' };
  }

  const current = summarizeDemElevations(currentElevations);
  if (!current.valid) {
    console.warn(`[sw-dem][health] invalid stats ${z}/${x}/${y} src=${demSource}`);
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'invalid-stats' };
  }

  if (current.max <= -9000 || current.mean <= DEM_HEALTH_NODATA_MEAN_M) {
    const recovered = await tryParentOverzoom(cache, z, x, y, 0);
    if (recovered?.blob) {
      console.warn(
        `[sw-dem][health] rejecting nodata-like tile ${z}/${x}/${y} src=${demSource} mean=${current.mean.toFixed(1)} -> ${recovered.source}`,
      );
      return {
        blob: recovered.blob,
        demSource: `${recovered.source}-healthguard`,
        shortCache: true,
        healthStatus: 'recovered',
      };
    }
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'nodata-like' };
  }

  const parentFallback = await tryParentOverzoom(cache, z, x, y, 0);
  if (!parentFallback?.blob) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  let parentElevations;
  try {
    parentElevations = await decodeTerrainRGBBlob(parentFallback.blob);
  } catch {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  const parent = summarizeDemElevations(parentElevations);
  if (!parent.valid) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  const meanDelta = Math.abs(current.mean - parent.mean);
  const collapsedRangeThreshold = Math.max(DEM_HEALTH_MIN_COLLAPSED_RANGE_M, parent.range * 0.15);
  const collapsedRelief = parent.range >= DEM_HEALTH_MIN_PARENT_RANGE_M && current.range <= collapsedRangeThreshold;
  const verticalDrop = current.max < parent.min - DEM_HEALTH_VERTICAL_OFFSET_M;
  const verticalRise = current.min > parent.max + DEM_HEALTH_VERTICAL_OFFSET_M;
  const hugeOffset = meanDelta >= DEM_HEALTH_MAX_MEAN_DELTA_M;

  if (verticalDrop || verticalRise || (collapsedRelief && hugeOffset)) {
    console.warn(
      `[sw-dem][health] rejecting anomalous tile ${z}/${x}/${y} src=${demSource} current=[${current.min.toFixed(1)}..${current.max.toFixed(1)}] parent=[${parent.min.toFixed(1)}..${parent.max.toFixed(1)}] meanDelta=${meanDelta.toFixed(1)} -> ${parentFallback.source}`,
    );
    return {
      blob: parentFallback.blob,
      demSource: `${parentFallback.source}-healthguard`,
      shortCache: true,
      healthStatus: 'recovered',
    };
  }

  return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
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
  const inLiDARRiskRegion = isExpertFallbackRiskTile(z, x, y);
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new Request(`/dem-tiles/${z}/${x}/${y}`);

  // 1. Positive cache
  const cached = await cache.match(cacheKey);
  if (cached) {
    const ttlMs = parseInt(cached.headers.get('x-cache-ttl-ms') || '0', 10);
    if (!ttlMs) return cached;

    const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
    if (cachedAt > 0 && (Date.now() - cachedAt) < ttlMs) return cached;

    await cache.delete(cacheKey);
  }

  // 2. Negative cache (TTL-bounded)
  const negCache = await caches.open(NEGATIVE_CACHE_NAME);
  const negCached = await negCache.match(cacheKey);
  if (negCached) {
    const age = parseInt(negCached.headers.get('x-cached-at') || '0', 10);
    const ttl = parseInt(negCached.headers.get('x-neg-ttl') || String(NEGATIVE_TTL_PIPELINE), 10);
    if (age && (Date.now() - age) < ttl * 1000) {
      // Try overzoom once, else honour the negative cache
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, inLiDARRiskRegion);
      return noTileResponse('neg-cache');
    }
    negCache.delete(cacheKey);
  }

  const inFrance = tileOverlapsFrance(z, x, y);
  const inSwitzerland = tileOverlapsSwitzerland(z, x, y);
  let tileIsInFrance = false; // hoisted so catch-handler can use it for finalize()
  try {
    let pngBlob;
    let demSource = 'none';
    let forceShortCache = false;
    let healthStatus = 'ok';

    // 3. IGN France pipeline — gated by pixel-density, not a hardcoded zoom.
    // shouldUseIGN(z, lat) returns true when the rendered pixel is smaller
    // than Mapbox's ~30 m native sample distance, so we invest IGN cost only
    // where LiDAR detail is actually visible. Latitude-aware: handles Corsica
    // (low lat, earlier crossover) and Dunkirk (high lat, later crossover)
    // with the same continuous function instead of a magic-number zoom.
    let upgradePending = null; // in-flight IGN sub-tile fetches for background re-cache
    let upgradeSourceHint = '';
    let ignHadSomeData = false; // true when MNS returned partial/full coverage
    const tileBounds = mercatorTileBounds(z, x, y);
    const tileCenterLat = (tileBounds.north + tileBounds.south) / 2;
    const useFranceMNS = shouldUseIGN(z, tileCenterLat);
    const useFranceHighres = useFranceMNS || shouldUseIGNHighres(z, tileCenterLat);

    // ── Resolve France polygon classification UP-FRONT.
    // tileOverlapsFrance() is a generous bbox check that ALSO covers most of
    // Switzerland (FRANCE_BOUNDS is [-5.5, 41, 10.0, 51.5]). The previous
    // version of this dispatcher used `!inFrance` to gate the Swiss branch,
    // which silently disabled it across ~95 % of CH. The polygon test below
    // is the authoritative "is this tile actually inside France" answer and
    // is what gates both branches now.
    let franceClass = 'outside';
    let tileCenterInFrancePoly = false;
    if (inFrance && useFranceHighres) {
      if (await ensureFrancePoly()) {
        franceClass = classifyDemTile(z, x, y);
        // classifyDemTile() promotes any z≥12 tile that overlaps the France
        // BBOX to 'border' even when the polygon contains 0 sample points
        // (deliberate safety net for sub-100 m summit tiles whose 6×6
        // sampling can miss a French sliver near Mont-Blanc/Pyrénées).
        // That promotion ALSO catches the entire Swiss plateau because
        // FRANCE_BOUNDS extends east to lng=10.0. We therefore additionally
        // test the tile centre against the polygon to know whether the
        // tile is *predominantly* French (→ IGN wins) or merely brushes
        // the bbox (→ Swiss wins when the tile is in CH).
        const centerLng = (tileBounds.west + tileBounds.east) / 2;
        const centerLat = (tileBounds.north + tileBounds.south) / 2;
        tileCenterInFrancePoly = pointInFrance(centerLng, centerLat);
      }
    }
    // tileIsInFrance: any French overlap (used for IGN gating, finalize
    // flags). Border tiles still go through IGN even when the centre is
    // in CH, because IGN MNS may cover the French strip.
    tileIsInFrance = franceClass !== 'outside';
    // tilePredominantlyFrench: only true when the tile centre actually
    // sits inside France polygon (or the polygon fully covers the tile).
    // Used to decide who *wins* between Swiss and IGN when both could run.
    const tilePredominantlyFrench = franceClass === 'inside' || tileCenterInFrancePoly;

    // ── Stricter "tile actually overlaps France polygon" test.
    //
    // classifyDemTile() promotes any z≥12 tile inside the FRANCE_BOUNDS
    // bbox (-5.5..10.0 lng) to 'border' as a safety-net for Mont-Blanc /
    // Pyrenees summit tiles where 6×6 polygon sampling can miss a French
    // sliver. Side-effect: tiles deep inside Switzerland (Sion at lng 7.3
    // is ~50 km east of France) ALSO get franceClass='border', so
    // tileIsInFrance flips true, raceIGNBorderTile fires, IGN burns the
    // request slot pool serially while Swiss STAC times out at 8 s.
    //
    // tileTrulyTouchesFrance: explicit polygon test on the tile centre
    // and 4 mid-edge points. If all 5 are outside France polygon AND
    // we're firmly inside CH, IGN has zero plausible data for the tile
    // — skip the race AND skip the post-Swiss IGN fallback entirely so
    // Swiss gets all the bandwidth.
    let tileTrulyTouchesFrance = tileIsInFrance;
    if (tileIsInFrance && franceClass === 'border' && inSwitzerland) {
      // franceClass=='border' implies ensureFrancePoly() succeeded above,
      // so pointInFrance() is safe to call here.
      const cLng = (tileBounds.west + tileBounds.east) / 2;
      const cLat = (tileBounds.north + tileBounds.south) / 2;
      tileTrulyTouchesFrance =
        tileCenterInFrancePoly ||
        pointInFrance(tileBounds.west, cLat) ||
        pointInFrance(tileBounds.east, cLat) ||
        pointInFrance(cLng, tileBounds.north) ||
        pointInFrance(cLng, tileBounds.south);
    }

    // ── Switzerland branch — runs when the tile is over the Swiss LV95
    // footprint AND not predominantly French. Border tiles where the
    // French polygon claims the centre still go to IGN.
    let swissHadSomeData = false;
    let swissTransientFailure = false; // STAC/header timeout; do NOT cache Mapbox flat as the answer
    const considerSwiss = inSwitzerland && !tilePredominantlyFrench && shouldUseSwiss(z, tileCenterLat);
    // Race IGN in parallel only for tiles that genuinely straddle the
    // French border polygon — not for every CH tile that bbox-overlaps
    // FRANCE_BOUNDS. This frees the IGN/network queue for Swiss STAC.
    const raceIGNBorderTile = considerSwiss && tileTrulyTouchesFrance;
    let ignResultPromise = null;
    if (raceIGNBorderTile) {
      ignResultPromise = buildIGNTile(z, x, y, franceClass);
    }
    if (z >= 12) {
      console.log(
        `[sw-dem][dispatch] %c ${z}/${x}/${y} %c inFrance(bbox)=${inFrance} franceClass=${franceClass} ctrInFR=${tileCenterInFrancePoly} trulyFR=${tileTrulyTouchesFrance} predomFR=${tilePredominantlyFrench} inSwitz=${inSwitzerland} considerSwiss=${considerSwiss} raceIGN=${raceIGNBorderTile}`,
        'background:#444;color:#fff;padding:1px 4px;border-radius:2px', '',
      );
    }
    if (considerSwiss) {
      const swissResult = await buildSwissTile(z, x, y);
      if (swissResult && swissResult.elevations) {
        swissHadSomeData = true;
        await acquireComposite();
        try {
          pngBlob = await compositeIGNMapbox(
            swissResult.elevations, swissResult.coverage, z, x, y,
          );
        } finally {
          releaseComposite();
        }
        demSource = 'swiss-composite';
      } else {
        // 'swiss-unavailable' = transient (STAC timeout, header retry exhausted,
        // range fetches died). Don't fall through to a cached Mapbox flat tile
        // at high zoom — that visually looks like a permanent flat patch next
        // to neighbours that worked. Treat it like an IGN transient miss:
        // skip Mapbox so we 204 with short TTL and Mapbox GL uses its own
        // parent mesh (a LiDAR tile from one zoom up).
        if (swissResult?.source === 'swiss-unavailable') swissTransientFailure = true;
        console.log(
          `[sw-dem][dispatch] %c ${z}/${x}/${y} %c swiss result=${swissResult?.source || 'null'} → falling through`,
          'background:#FF9800;color:#fff;padding:1px 4px;border-radius:2px', '',
        );
      }
    }

    // Use tileTrulyTouchesFrance (real polygon overlap) — not the bbox-promoted
    // tileIsInFrance — to gate IGN. Tiles deep inside CH (e.g. Sion) bbox-overlap
    // FRANCE_BOUNDS but have zero IGN data; running IGN there only burns the
    // request slot pool serially while Swiss STAC starves and times out.
    if (!pngBlob && tileTrulyTouchesFrance && useFranceMNS) {
      const ignResult = ignResultPromise
        ? await ignResultPromise
        : await buildIGNTile(z, x, y, franceClass);
      if (ignResult) {
        upgradePending = ignResult.pendingFetches;
        if (ignResult.pendingFetches?.length) upgradeSourceHint = 'ign';
        if (ignResult.elevations) {
          // MNS returned actual elevation data (partial or full coverage)
          ignHadSomeData = true;
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
        // else: 0-coverage result — elevations is null. MNS had no data
        // for this tile. Record in area negative cache for fast skip on
        // adjacent tiles. Fall through to HIGHRES fallback below.
        if (!ignHadSomeData && ignResult.allPermanent404) {
          mnsAreaNegSet(z, x, y);
        }
      }
    }

    // 3a. HIGHRES (5 m DEM) fallback — broader coverage than MNS LiDAR HD.
    // Used when MNS returned 0 coverage (no LiDAR HD data for this area).
    // HIGHRES covers all of France at ~5 m resolution — 6× better than
    // Mapbox 30 m. Only fires when MNS had no data; when MNS returned
    // partial data the composite path above already handled it.
    if (!pngBlob && tileTrulyTouchesFrance && useFranceHighres && !ignHadSomeData) {
      const highresResult = await buildIGNFallbackTile(z, x, y);
      if (highresResult) {
        if (highresResult.elevations) {
          if (highresResult.blob) {
            pngBlob = highresResult.blob;
            demSource = highresResult.source || 'ign-highres';
          } else {
            await acquireComposite();
            try {
              pngBlob = await compositeIGNMapbox(highresResult.elevations, highresResult.coverage, z, x, y);
            } finally {
              releaseComposite();
            }
            demSource = 'ign-highres-composite';
          }
        }
        // Merge pending fetches from HIGHRES (if any) with MNS pending
        if (highresResult.pendingFetches) {
          upgradeSourceHint = 'ign-highres';
          upgradePending = upgradePending
            ? [...upgradePending, ...highresResult.pendingFetches]
            : highresResult.pendingFetches;
        }
      }
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
    if (!pngBlob && tileIsInFrance && z > MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-lidar-parent';
      }
    }

    // 3c. Same LiDAR-preserving path for Switzerland: at high zoom we never
    // want to fall through to a server-overzoomed Mapbox tile when we have
    // a parent COG-derived blob in our own cache. Use tileTrulyTouchesFrance
    // (not bbox-promoted tileIsInFrance) so deep-CH tiles still hit this path.
    if (!pngBlob && inSwitzerland && !tileTrulyTouchesFrance && z > MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-swiss-parent';
      }
    }

    // 4. Mapbox global fallback — only at low zoom or outside France/CH.
    // Inside France/CH at mercZ > MAPBOX_DEM_MAXZOOM we skip this ONLY when
    // the LiDAR pipeline returned data. When neither LiDAR source had any
    // coverage, Mapbox overzoomed 30 m is better than nothing.
    const globalHighZoomParentMesh =
      z > MAPBOX_DEM_MAXZOOM
      && !tileTrulyTouchesFrance
      && !inSwitzerland;
    const skipMapboxHighZoomLiDAR =
      z > MAPBOX_DEM_MAXZOOM && (
        (tileTrulyTouchesFrance && ignHadSomeData) ||
        (inSwitzerland && !tileTrulyTouchesFrance && swissHadSomeData) ||
        // Swiss transient failure: do NOT cache a flat Mapbox tile in
        // place of an unbuilt LiDAR tile — visually indistinguishable
        // from a permanent flat patch (see screenshot Apr 24).
        (inSwitzerland && !tileTrulyTouchesFrance && swissTransientFailure)
      );
    const allowGlobalFallbackTile = !globalHighZoomParentMesh && !skipMapboxHighZoomLiDAR;
    // AWS Terrarium replaces Mapbox terrain-DEM globally. No token needed,
    // free public dataset, ~30 m worldwide. Mapbox SKU savings: ~−40 % of
    // Raster Tiles API. France/CH still use IGN/swissALTI for high zoom.
    // Outside LiDAR regions we stop at the dataset's native z14 detail and
    // let the renderer reuse the parent mesh above that. Synthesizing z15+
    // child DEM tiles in the SW progressively smooths the relief until the
    // terrain appears flat.
    if (!pngBlob && allowGlobalFallbackTile) {
      pngBlob = await fetchAWSTerrainTile(z, x, y);
      if (pngBlob) demSource = 'aws-terrarium';
    }

    // 5. Single-step parent overzoom (outside-LiDAR & low-zoom path).
    if (!pngBlob && allowGlobalFallbackTile) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source;
      }
    }

    // 6. Nothing worked — 204 with short TTL for transient failures, long for
    //    confirmed empty outside the supported LiDAR regions.
    if (!pngBlob) {
      const isConfirmedEmpty = globalHighZoomParentMesh || (!tileIsInFrance && !inSwitzerland);
      const ttl = isConfirmedEmpty ? NEGATIVE_TTL_CONFIRMED : NEGATIVE_TTL_PIPELINE;
      const reason = globalHighZoomParentMesh
        ? 'global-parent-mesh'
        : skipMapboxHighZoomLiDAR
        ? (tileIsInFrance ? 'ign-pending-highzoom' : 'swiss-pending-highzoom')
        : ((tileIsInFrance || inSwitzerland) ? 'pipeline-error' : 'no-coverage');
      if (upgradePending && upgradePending.length) {
        scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint);
      }
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

    const guarded = await guardDemTileHealth(cache, pngBlob, z, x, y, demSource);
    if (!guarded.blob) {
      if (upgradePending && upgradePending.length) {
        scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint || demSource);
      }
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: {
          'x-cached-at': String(Date.now()),
          'x-neg-ttl': String(NEGATIVE_TTL_PIPELINE),
        },
      }));
      return noTileResponse(guarded.reason || 'health-guard');
    }

    pngBlob = guarded.blob;
    demSource = guarded.demSource;
    forceShortCache = guarded.shortCache;
    healthStatus = guarded.healthStatus;

    return finalize(
      cache,
      cacheKey,
      t0,
      z,
      x,
      y,
      pngBlob,
      demSource,
      upgradePending,
      tileIsInFrance || inSwitzerland,
      upgradeSourceHint,
      forceShortCache,
      healthStatus,
    );
  } catch (err) {
    console.error('[sw-dem] error', z, x, y, err);
    const fb = await tryParentOverzoom(cache, z, x, y, _depth);
    if (fb) {
      return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, tileIsInFrance || inSwitzerland, '', false, 'ok');
    }
    return noTileResponse('error');
  }
}

async function finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource, upgradePending, inLiDARRegion, upgradeSourceHint, forceShortCache = false, healthStatus = 'ok') {
  // Short cache (15 s) for AWS/overzoom fallback tiles inside any LiDAR
  // region (France or Switzerland) at z≥13. These are transient stand-ins
  // while the exact tile finishes building; longer caching masks the upgrade.
  const shortCache = forceShortCache || (inLiDARRegion
    && z >= 13
    && (demSource.startsWith('aws-terrarium') || demSource.startsWith('overzoom')));
  const response = buildDemResponse(pngBlob, demSource, shortCache, healthStatus);
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
    scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint || demSource);
  }
  return response;
}

function notifyDemTileCacheUpdated(z, x, y, source) {
  self.clients.matchAll({ type: 'window' })
    .then((clients) => {
      clients.forEach((client) => client.postMessage({
        type: 'DEM_TILE_CACHE_UPDATED',
        z,
        x,
        y,
        source,
      }));
    })
    .catch(() => {
      /* best-effort notification */
    });
}

// Coalesce concurrent upgrade jobs for the same tile.
const pendingUpgrades = new Set();

async function materializeUpgradeResult(result, z, x, y, compositeSource) {
  if (!result?.elevations) return null;
  if (result.blob) {
    return { blob: result.blob, source: result.source || compositeSource };
  }

  await acquireComposite();
  try {
    return {
      blob: await compositeIGNMapbox(result.elevations, result.coverage, z, x, y),
      source: compositeSource,
    };
  } finally {
    releaseComposite();
  }
}

function scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, fetches, preferredSource) {
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
      const preferHighres = typeof preferredSource === 'string'
        && preferredSource.startsWith('ign-highres');
      const rebuilders = preferHighres
        ? [
            () => buildIGNFallbackTile(z, x, y).then((result) => materializeUpgradeResult(result, z, x, y, 'ign-highres-composite')),
            () => buildIGNTile(z, x, y, tileClass).then((result) => materializeUpgradeResult(result, z, x, y, 'ign-composite')),
          ]
        : [
            () => buildIGNTile(z, x, y, tileClass).then((result) => materializeUpgradeResult(result, z, x, y, 'ign-composite')),
            () => buildIGNFallbackTile(z, x, y).then((result) => materializeUpgradeResult(result, z, x, y, 'ign-highres-composite')),
          ];

      let upgraded = null;
      for (const rebuild of rebuilders) {
        upgraded = await rebuild();
        if (upgraded?.blob) break;
      }
      if (!upgraded?.blob) return;

      await cache.put(cacheKey, buildDemResponse(upgraded.blob, upgraded.source + '+upgrade'));
      notifyDemTileCacheUpdated(z, x, y, upgraded.source);
      if (DEBUG) console.log(`[sw-dem][upgrade] ${z}/${x}/${y} re-cached at ${upgraded.source}`);
    } catch (e) {
      if (DEBUG) console.warn(`[sw-dem][upgrade] ${z}/${x}/${y} failed`, e);
    } finally {
      pendingUpgrades.delete(key);
    }
  })();
}

// ---------------------------------------------------------------------------
// Shadow request handler — RETIRED.
// ---------------------------------------------------------------------------
// Cast shadows are now computed in-page by a dedicated worker that owns a
// single viewport-sized elevation grid (see src/features/sunlight). The
// per-tile pipeline served here was paying a full Mapbox tile-fetch cycle
// every time the sun moved one degree; the new design only re-runs the
// horizon sweep on the cached grid, no tile churn at all.

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

async function handleSlopeRequest(z, x, y, resParam) {
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const resFactor = (() => {
    const n = parseInt(resParam, 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 64) : 1;
  })();
  const resSuffix = resFactor > 1 ? `?res=${resFactor}` : '';
  const cacheKey = new Request(`/slope-tiles/${z}/${x}/${y}${resSuffix}`);
  const cached = await slopeCache.match(cacheKey);
  if (cached) return cached;

  // ── In-flight coalescing ────────────────────────────────────────────
  // Rapid toggling / panning can spawn duplicate concurrent requests for
  // the same tile. Without dedup, each one runs the full DEM-decode +
  // Horn + PNG-encode pipeline. We share the first promise across all
  // callers and clone the response per-consumer (Response bodies are
  // single-use streams).
  const inflightKey = `${z}/${x}/${y}?${resFactor}`;
  const existing = SLOPE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
    let demResponse = await demCache.match(demKey);
    if (!demResponse || demResponse.status !== 200) {
      demResponse = await handleDemRequest(demKey, z, x, y);
    }
    if (!demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    // Pre-warm the 4 neighbour DEM tiles so the slope padding always uses
    // real elevations, not the own-edge replication that produces visible
    // 1-pixel seams between adjacent slope tiles. We allow each neighbour to
    // fail silently — `buildPaddedElevations` still has its replicate-edge
    // fallback for tiles outside coverage / 204'd by Mapbox.
    await Promise.all([
      [x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y],
    ].map(async ([nx, ny]) => {
      if (ny < 0 || nx < 0) return;
      const nKey = new Request(`/dem-tiles/${z}/${nx}/${ny}`);
      const existingDem = await demCache.match(nKey);
      if (existingDem && existingDem.status === 200) return;
      try { await handleDemRequest(nKey, z, nx, ny); } catch { /* ignore */ }
    }));

    try {
      const demBlob = await demResponse.clone().blob();
      const slopeBlob = await buildSlopeTile(demBlob, z, x, y, demCache, resFactor);
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
  })();

  SLOPE_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    SLOPE_INFLIGHT.delete(inflightKey);
  }
}

async function handleAltitudeRequest(z, x, y) {
  const altitudeCache = await caches.open(ALTITUDE_CACHE_NAME);
  const cacheKey = new Request(`/altitude-tiles/${z}/${x}/${y}`);
  const cached = await altitudeCache.match(cacheKey);
  if (cached) return cached;

  const inflightKey = `${z}/${x}/${y}`;
  const existing = ALTITUDE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demKey = new Request(`/dem-tiles/${z}/${x}/${y}`);
    let demResponse = await demCache.match(demKey);
    if (!demResponse || demResponse.status !== 200) {
      demResponse = await handleDemRequest(demKey, z, x, y);
    }
    if (!demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      const altitudeBlob = await buildAltitudeTile(demBlob);
      const response = new Response(altitudeBlob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'X-Tile-Type': 'altitude',
        },
      });
      altitudeCache.put(cacheKey, response.clone());
      return response;
    } catch (err) {
      console.error('[altitude]', z, x, y, err);
      return transparentTileResponse();
    }
  })();

  ALTITUDE_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    ALTITUDE_INFLIGHT.delete(inflightKey);
  }
}
