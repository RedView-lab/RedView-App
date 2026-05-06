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
// Now we kick the neighbour pre-warm as fire-and-forget. Each DEM call is
// deduped by DEM_INFLIGHT so an adjacent slope tile that needs the same
// neighbour shares the in-flight Promise. Slope tile #1 will use replicated
// edges (1-px own-tile fallback inside buildPaddedElevations); slope tile
// #2 (neighbour now cached) gets the seam-free version.  The visible
// difference is minimal at typical opacity, the throughput improvement is
// large.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

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

    // Fire-and-forget neighbour pre-warm. Deduped by DEM_INFLIGHT so it
    // costs one dispatcher cycle per neighbour at most across the entire
    // viewport (instead of N×4 awaited cycles per slope tile). The slope
    // response is NOT blocked on this — buildPaddedElevations already
    // falls back to own-edge replication when a neighbour is missing.
    //
    // Self-healing seam: if any neighbour was missing at compute time, the
    // slope tile we cache now has 1-px own-edge replication on that side
    // (visible as inter-tile seams, especially at high res like 1 m
    // surface). Once the missing neighbours land in the DEM cache we
    // notify the page so it invalidates this slope tile and reloads —
    // the recomputed tile will use real neighbour data and be seam-free.
    const missingNeighbours = [];
    const neighbourFetches = [];
    for (const [nx, ny] of [
      [x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y],
    ]) {
      if (ny < 0 || nx < 0) continue;
      const nKey = buildDemCacheKey(z, nx, ny, demProfile);
      neighbourFetches.push(
        demCache.match(nKey).then((existingDem) => {
          if (existingDem && existingDem.status === 200) return false;
          missingNeighbours.push([nx, ny]);
          return handleDemRequest(nKey, z, nx, ny, undefined, demProfile)
            .then(() => true)
            .catch(() => false);
        }).catch(() => false),
      );
    }

    try {
      const demBlob = await demResponse.clone().blob();
      const slopeBlob = await buildSlopeTile(demBlob, z, x, y, demCache, resFactor, demProfile);
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

      // Self-heal kick: if some neighbours were missing, wait for them to
      // land then notify the page so it invalidates this slope tile and
      // re-requests it (the recompute will read the now-cached neighbours
      // and produce a seam-free tile). Coalesced through DEM_INFLIGHT
      // and the controller's debounced sourceCache.reload(); the cost is
      // capped to one extra slope recompute per (z,x,y) per cold-load.
      if (missingNeighbours.length > 0) {
        Promise.allSettled(neighbourFetches).then(() => {
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
      }
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
