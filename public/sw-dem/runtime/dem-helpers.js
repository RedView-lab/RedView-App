// ---------------------------------------------------------------------------
// Shared response helpers and the safe parent-overzoom fallback used by
// both handleDemRequest and the health guard.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

function buildDemResponse(pngBlob, demSource, shortCache, healthStatus = 'ok') {
  const cachedAt = Date.now();
  const shortTtlMs = shortCache ? 15_000 : 0;
  return new Response(pngBlob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // 30-day TTL on positive DEM tiles. Both AWS Terrarium and IGN/swiss
      // LiDAR DEM datasets are static reference data — keeping the SW cache
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

// Minimal 1×1 transparent PNG used as a safe fallback when DEM data is absent.
// Generated with node:zlib (deflate + CRC32) and checked chunk by chunk: the
// previous literal had a bad IDAT CRC / Adler-32, so browsers rejected it.
const TRANSPARENT_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUA' +
  'Aen63NgAAAAASUVORK5CYII='
), (c) => c.charCodeAt(0));

function transparentTileResponse() {
  return new Response(TRANSPARENT_PNG.slice(), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      'X-Tile-Type': 'transparent',
    },
  });
}

function isExpertFallbackRiskTile(z, x, y) {
  return z >= 12 && (
    tileOverlapsFrance(z, x, y)
    || tileOverlapsOverseasFrance(z, x, y)
    || tileOverlapsSwitzerland(z, x, y)
    || tileOverlapsNorway(z, x, y)
    || tileOverlapsSpain(z, x, y)
  );
}

function resolveDemProfile(url) {
  return url.searchParams.get('rv-dem-profile') === 'terrain' ? 'terrain' : 'default';
}

function resolveDemProfileFromRequest(request) {
  try {
    return resolveDemProfile(new URL(request.url, self.location.origin));
  } catch {
    return 'default';
  }
}

function resolveDemRequestPurposeFromRequest(request) {
  try {
    const url = new URL(request.url, self.location.origin);
    const purpose = url.searchParams.get('rv-purpose');
    if (purpose) return purpose;
    if (url.searchParams.get('pf') === '1') return 'dem-prefetch';
    return null;
  } catch {
    return null;
  }
}

function buildDemCacheKey(z, x, y, demProfile) {
  const profileQuery = demProfile === 'terrain' ? '?rv-dem-profile=terrain' : '';
  return new Request(`/dem-tiles/${z}/${x}/${y}${profileQuery}`);
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
    || parentSource.startsWith('aws-emergency')
    || parentSource.startsWith('mapbox')
    || parentSource.startsWith('overzoom')
    || parentSource.includes('fastpath');
}

function shouldAllowParentOverzoomFallback(z, x, y) {
  if (z <= MAPBOX_DEM_MAXZOOM) return true;
  return isExpertFallbackRiskTile(z, x, y);
}

// Elevation stats (min/max/mean) of the part of the nearest ALREADY-AVAILABLE
// parent tile that covers (z, x, y). Used by the health guard to compare a
// freshly built tile against its ancestor.
//
// Unlike tryParentOverzoom this never builds anything: hot tier and
// CacheStorage only (no handleDemRequest → no WMS fetch, no recursive parent
// chain), and no Catmull-Rom overzoom + PNG encode + decode round-trip — the
// stats are read straight from the parent's sub-rectangle. Returns
// { stats, source, parentZ } or null when no usable parent is cached.
async function findCachedParentStats(cache, z, x, y, demProfile = 'default') {
  if (!shouldAllowParentOverzoomFallback(z, x, y)) return null;
  const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
  const levels = [];
  for (let pZ = z - 1; pZ >= minParentZ; pZ--) levels.push(pZ);
  if (levels.length === 0) return null;

  // Hot tier first (same Blob identity → decode-cache hit), then a single
  // parallel round of CacheStorage lookups for the levels that missed.
  const candidates = levels.map((pZ) => {
    const key = buildDemCacheKey(pZ, x >> (z - pZ), y >> (z - pZ), demProfile);
    const hot = (typeof demHotGet === 'function') ? demHotGet(key.url) : null;
    return { pZ, key, hot };
  });
  const matched = await Promise.all(candidates.map((c) => (
    c.hot ? null : cache.match(c.key).catch(() => null)
  )));

  for (let i = 0; i < candidates.length; i++) {
    const { pZ, hot } = candidates[i];
    let headers;
    let blobPromise;
    if (hot) {
      headers = new Headers(hot.headers);
      blobPromise = Promise.resolve(hot.blob);
    } else {
      const resp = matched[i];
      if (!resp || resp.status !== 200) continue;
      headers = resp.headers;
      blobPromise = resp.blob();
    }
    const headerView = { headers };
    if (shouldSkipUnsafeOverzoomParent(headerView, z, x, y)) continue;

    try {
      const parentElevations = await decodeTerrainRGBBlob(await blobPromise);
      const size = Math.round(Math.sqrt(parentElevations.length));
      const dz = z - pZ;
      const span = size >> dz;
      if (span < 1) continue;
      const x0 = (x - ((x >> dz) << dz)) * span;
      const y0 = (y - ((y >> dz) << dz)) * span;
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let count = 0;
      for (let py = y0; py < y0 + span; py++) {
        const row = py * size;
        for (let px = x0; px < x0 + span; px++) {
          const v = parentElevations[row + px];
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          count++;
        }
      }
      if (count === 0) continue;
      return {
        stats: { valid: true, min, max, mean: sum / count, range: max - min },
        source: headers.get('X-DEM-Source') || 'unknown',
        parentZ: pZ,
      };
    } catch {
      /* try the next ancestor */
    }
  }
  return null;
}

async function tryParentOverzoom(cache, z, x, y, depth, demProfile = 'default') {
  if (depth > 0) return null;
  if (!shouldAllowParentOverzoomFallback(z, x, y)) return null;

  const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
  for (let pZ = z - 1; pZ >= minParentZ; pZ--) {
    const pX = x >> (z - pZ);
    const pY = y >> (z - pZ);
    const parentKey = buildDemCacheKey(pZ, pX, pY, demProfile);

    // Fast path: in-memory hot tier (see DEM_HOT_CACHE in lifecycle.js).
    // Overzoom is in the hot path for every miss inside FR/CH/ES/NO at
    // z>14 and on every short-TTL refresh; skipping CacheStorage here
    // for already-warm parents removes another 5-25 ms × parent-depth
    // (up to 4) from the slow path of each held viewport tile.
    let parentResp = null;
    const parentHotKey = parentKey.url;
    const parentHot = (typeof demHotGet === 'function') ? demHotGet(parentHotKey) : null;
    if (parentHot) {
      parentResp = demHotResponse(parentHot);
    } else {
      parentResp = await cache.match(parentKey);
    }
    if (!parentResp || parentResp.status !== 200) {
      parentResp = await handleDemRequest(parentKey, pZ, pX, pY, depth + 1, demProfile);
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
        // Reject parent overzooms that collapse to a flat zero raster over
        // France/CH. A z14 cached tile that decoded as all-0 (Mapbox/AWS
        // tile over a no-data pocket, decoded-as-zero placeholder) would
        // otherwise propagate as a perfectly flat slab to every child
        // tile that falls back to it. Continue to the next parent zoom.
        if (isExpertFallbackRiskTile(z, x, y)) {
          try {
            const overzoomedElev = await decodeTerrainRGBBlob(overzoomed);
            const stats = summarizeDemElevations(overzoomedElev);
            if (isFlatlinedInlandStats(stats, z, x, y)) {
              if (DEBUG) console.warn(
                `[sw-dem][overzoom] skip flat-inland parent ${pZ}/${pX}/${pY} for ${z}/${x}/${y} src=${parentSource}`,
              );
              continue;
            }
          } catch { /* if decode fails, accept as before */ }
        }
        return { blob: overzoomed, source: `overzoom-z${pZ}:${parentSource}` };
      }
    } catch (err) {
      if (DEBUG) console.warn(`[sw-dem] overzoom failed ${pZ}/${pX}/${pY}`, err);
    }
  }
  return null;
}
