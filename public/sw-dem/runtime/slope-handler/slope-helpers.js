// ---------------------------------------------------------------------------
// Slope Tile Processing — Shared Helpers & Neighbour Prewarming
// ---------------------------------------------------------------------------

const SLOPE_NEIGHBOUR_WARM_DELAY_MS = 120;
const SLOPE_REQUEST_PURPOSE_VISIBLE = 'slope-visible';
const SLOPE_REQUEST_PURPOSE_WARM = 'slope-warm';
const DEBUG_SLOPE = false;

function logDemPente(...args) {
  if (!DEBUG_SLOPE) return;
  console.log('[DEM PENTE]', ...args);
  try {
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'DEM_PENTE_LOG',
          message: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
        });
      });
    }).catch(() => {});
  } catch { /* ignore */ }
}

async function invalidateParentDownsampledSlopeTiles(z, x, y, zoneHash) {
  if (!zoneHash) return;
  try {
    if (typeof slopeHotInvalidateZoneDownsampled === 'function') {
      slopeHotInvalidateZoneDownsampled(zoneHash);
    }
    const slopeCache = await caches.open(SLOPE_CACHE_NAME);
    const keys = await slopeCache.keys();
    const zoneSub = `zone=${zoneHash}`;
    const toDelete = [];
    for (const req of keys) {
      const url = req.url;
      if (url.includes(zoneSub)) {
        const match = url.match(/\/slope-tiles\/(\d+)\//);
        if (match && parseInt(match[1], 10) < 14) {
          toDelete.push(slopeCache.delete(req));
        }
      }
    }
    await Promise.all(toDelete);
  } catch { /* best-effort */ }
}

function isSlopeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== slopeCancelGeneration;
}

function buildSlopeDemRequest(z, x, y, demProfile, purpose) {
  const params = new URLSearchParams();
  if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
  if (purpose) params.set('rv-purpose', purpose);
  return new Request(`/dem-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`);
}

function slopeNeighbourWarmList(z, neighbours) {
  const n = 1 << z;
  const seen = new Set();
  const out = [];
  for (const item of neighbours || []) {
    if (!Array.isArray(item)) continue;
    const nx = item[0] | 0;
    const ny = item[1] | 0;
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
    const key = `${nx}/${ny}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([nx, ny]);
  }
  return out;
}

function scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, neighbours, generation) {
  const missing = slopeNeighbourWarmList(z, neighbours);
  if (missing.length === 0 || !demCache) return;

  setTimeout(() => {
    if (isSlopeWorkCancelled(generation)) return;
    const fetches = missing.map(([nx, ny]) => {
      const nKey = buildDemCacheKey(z, nx, ny, demProfile);
      return demCache.match(nKey).then((existingDem) => {
        if (existingDem && existingDem.status === 200) return true;
        return handleDemRequest(
          buildSlopeDemRequest(z, nx, ny, demProfile, SLOPE_REQUEST_PURPOSE_WARM),
          z,
          nx,
          ny,
          undefined,
          demProfile,
        )
          .then((resp) => Boolean(resp && resp.status === 200))
          .catch(() => false);
      }).catch(() => false);
    });

    Promise.allSettled(fetches).then((results) => {
      if (isSlopeWorkCancelled(generation)) return;
      const warmed = results.some((result) => result.status === 'fulfilled' && result.value === true);
      if (!warmed) return;
      try {
        self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => client.postMessage({
            type: 'DEM_TILE_CACHE_UPDATED',
            z,
            x,
            y,
            source: 'slope-seam-heal',
            profile: demProfile,
          }));
        }).catch(() => { /* best-effort */ });
      } catch { /* noop */ }
    });
  }, SLOPE_NEIGHBOUR_WARM_DELAY_MS);
}

async function buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing) {
  let slopeResult = null;
  let usedPool = false;
  if (typeof computeSlopeViaPool === 'function') {
    try {
      const poolResult = await computeSlopeViaPool(
        demBlob,
        demCache,
        z,
        x,
        y,
        resFactor,
        demProfile,
        generation,
        zoneRing,
      );
      if (poolResult) {
        slopeResult = {
          blob: poolResult.blob,
          missingNeighbours: poolResult.missingDirections.map((dir) => {
            if (dir === 'north') return [x, y - 1];
            if (dir === 'east') return [x + 1, y];
            if (dir === 'south') return [x, y + 1];
            if (dir === 'west') return [x - 1, y];
            return null;
          }).filter(Boolean),
        };
        usedPool = true;
      }
    } catch {
      /* fall through to in-process */
    }
  }

  if (!usedPool) {
    slopeResult = await scheduleSlopeBuild(
      () => buildSlopeTile(demBlob, z, x, y, demCache, resFactor, demProfile, zoneRing),
      generation,
    );
  }

  if (!slopeResult || (generation !== null && isSlopeWorkCancelled(generation))) return null;
  return {
    blob: slopeResult.blob || slopeResult,
    missingNeighbours: slopeResult.missingNeighbours || [],
  };
}
