// ---------------------------------------------------------------------------
// Slope tile handler — owns /slope-tiles/{z}/{x}/{y}?[res=N&rv-dem-profile=…]
//
// Pipeline:
//   own DEM tile (handleDemRequest, deduped by DEM_INFLIGHT)
//     → buildSlopeTile() in slope.js (Horn 3×3 on a 258×258 padded buffer)
//       → PNG (sqrt-gamma single-channel, see slope.js header for encoding)
//
// Neighbour-tile pre-warming: the padded buffer wants 4 neighbour DEM tiles
// to remove 1-px seams between adjacent slope tiles. The previous version
// AWAITED all 4 neighbour pre-warms before computing the slope, which —
// combined with the lack of DEM-level dedup — turned each slope tile into
// 5 sequential DEM dispatcher cycles. On a 90-tile cold viewport that's
// up to 450 concurrent handleDemRequest calls; the resulting fetch/composite
// queue contention starved real slope responses past Mapbox's tile-load
// deadline, leaving the "Pentes XX/YY" pill stuck around 80–90 %.
//
// Now we build the visible slope tile first, report which neighbours were
// missing, then warm those neighbours after the response has been cached.
// This keeps foreground tiles ahead of seam-heal work in the shared IGN/WMS
// queue while preserving the second-pass seam-free quality once neighbours
// land in the DEM cache.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

const SLOPE_NEIGHBOUR_WARM_DELAY_MS = 120;

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

function scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, neighbours) {
  const missing = slopeNeighbourWarmList(z, neighbours);
  if (missing.length === 0 || !demCache) return;

  setTimeout(() => {
    const fetches = missing.map(([nx, ny]) => {
      const nKey = buildDemCacheKey(z, nx, ny, demProfile);
      return demCache.match(nKey).then((existingDem) => {
        if (existingDem && existingDem.status === 200) return true;
        return handleDemRequest(nKey, z, nx, ny, undefined, demProfile)
          .then((resp) => Boolean(resp && resp.status === 200))
          .catch(() => false);
      }).catch(() => false);
    });

    Promise.allSettled(fetches).then((results) => {
      const warmed = results.some((result) => result.status === 'fulfilled' && result.value === true);
      if (!warmed) return;
      try {
        self.clients.matchAll({ type: 'window' }).then((clients) => {
          clients.forEach((client) => client.postMessage({
            type: 'DEM_TILE_CACHE_UPDATED',
            z, x, y,
            source: 'slope-seam-heal',
          }));
        }).catch(() => { /* best-effort */ });
      } catch { /* noop */ }
    });
  }, SLOPE_NEIGHBOUR_WARM_DELAY_MS);
}

async function handleSlopeRequest(z, x, y, resParam, demProfile = 'default') {
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const resFactor = (() => {
    const n = parseInt(resParam, 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 64) : 1;
  })();
  const params = new URLSearchParams();
  if (resFactor > 1) params.set('res', String(resFactor));
  if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
  const cacheKey = new Request(`/slope-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`);
  const cached = await slopeCache.match(cacheKey);
  if (cached) return cached;

  // ── In-flight coalescing ────────────────────────────────────────────
  // Rapid toggling / panning can spawn duplicate concurrent requests for
  // the same tile. Without dedup, each one runs the full DEM-decode +
  // Horn + PNG-encode pipeline. We share the first promise across all
  // callers and clone the response per-consumer (Response bodies are
  // single-use streams).
  const inflightKey = `${demProfile}:${z}/${x}/${y}?${resFactor}`;
  const existing = SLOPE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* fall through and recompute */ }
  }

  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demKey = buildDemCacheKey(z, x, y, demProfile);
    let demResponse = await demCache.match(demKey);
    if (!demResponse || demResponse.status !== 200) {
      demResponse = await handleDemRequest(demKey, z, x, y, undefined, demProfile);
    }
    if (!demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      const slopeResult = await buildSlopeTile(demBlob, z, x, y, demCache, resFactor, demProfile);
      const slopeBlob = slopeResult?.blob || slopeResult;
      const response = new Response(slopeBlob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'X-Tile-Type': 'slope',
          'X-DEM-Profile': demProfile,
        },
      });
      slopeCache.put(cacheKey, response.clone());

      // Seam self-heal happens after the visible tile is returned. The first
      // pass is fast and uses replicated own-tile edges where needed; the
      // delayed warmup triggers one debounced Mapbox reload once neighbour DEM
      // tiles are available, yielding seam-free borders without starving the
      // foreground burst.
      scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, slopeResult?.missingNeighbours);
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
