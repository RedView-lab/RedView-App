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

function isExpertFallbackRiskTile(z, x, y) {
  return z >= 12 && (
    tileOverlapsFrance(z, x, y)
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
    || parentSource.startsWith('mapbox')
    || parentSource.startsWith('overzoom')
    || parentSource.includes('fastpath');
}

function shouldAllowParentOverzoomFallback(z, x, y) {
  if (z <= MAPBOX_DEM_MAXZOOM) return true;
  return isExpertFallbackRiskTile(z, x, y);
}

async function tryParentOverzoom(cache, z, x, y, depth, demProfile = 'default') {
  if (depth > 0) return null;
  if (!shouldAllowParentOverzoomFallback(z, x, y)) return null;

  const minParentZ = Math.max(0, z - DEM_OVERZOOM_MAX_DEPTH);
  for (let pZ = z - 1; pZ >= minParentZ; pZ--) {
    const pX = x >> (z - pZ);
    const pY = y >> (z - pZ);
    const parentKey = buildDemCacheKey(pZ, pX, pY, demProfile);

    let parentResp = await cache.match(parentKey);
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
