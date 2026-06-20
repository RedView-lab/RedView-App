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
const SLOPE_REQUEST_PURPOSE_VISIBLE = 'slope-visible';
const SLOPE_REQUEST_PURPOSE_WARM = 'slope-warm';

function isSlopeWorkCancelled(generation) {
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
            z, x, y,
            source: 'slope-seam-heal',
            profile: demProfile,
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
  const cacheKeyUrl = `/slope-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`;

  // ── Hot tier (SLOPE_HOT_CACHE) ──────────────────────────────────────
  // Sits in FRONT of CacheStorage exactly like DEM_HOT_CACHE. A pan-back
  // or resolution-switch re-asks for tiles that were served a moment ago;
  // this returns them in <1 ms instead of paying 5-25 ms for caches.match.
  const hotKey = `${demProfile}:${cacheKeyUrl}`;
  const hot = (typeof slopeHotGet === 'function') ? slopeHotGet(hotKey) : null;
  if (hot) return slopeHotResponse(hot);

  const cacheKey = new Request(cacheKeyUrl);
  const cached = await slopeCache.match(cacheKey);
  if (cached) {
    // Promote a fresh CacheStorage hit to the hot tier so the next request
    // skips CacheStorage entirely. Cheap (Blob is refcounted).
    try {
      if (typeof slopeHotPut === 'function') {
        slopeHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
      }
    } catch { /* ignore */ }
    return cached;
  }

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

  const generation = slopeCancelGeneration;
  const work = (async () => {
    const demCache = await caches.open(CACHE_NAME);
    const demKey = buildDemCacheKey(z, x, y, demProfile);
    // Hot-tier shortcut: skip the ~5-25 ms CacheStorage round-trip when
    // the DEM blob is still in the in-memory LRU. Slope is fired right
    // after the DEM lands (same idle cycle), so the hit ratio is high
    // during interactive use.
    let demResponse = null;
    const demHotEntry = (typeof demHotGet === 'function') ? demHotGet(demKey.url) : null;
    if (demHotEntry) {
      demResponse = demHotResponse(demHotEntry);
    } else {
      demResponse = await demCache.match(demKey);
    }
    if (!demResponse || demResponse.status !== 200) {
      demResponse = await handleDemRequest(
        buildSlopeDemRequest(z, x, y, demProfile, SLOPE_REQUEST_PURPOSE_VISIBLE),
        z,
        x,
        y,
        undefined,
        demProfile,
      );
    }
    if (isSlopeWorkCancelled(generation)) {
      return transparentTileResponse();
    }
    if (!demResponse || demResponse.status !== 200) {
      return transparentTileResponse();
    }

    // Gate the slope overlay to genuine relief sources.
    //
    // - `aws-terrarium` is the legitimate global best-source outside the
    //   LiDAR regions (FR/CH/NO/ES). Morocco, Iceland, Patagonia\u2026 the user
    //   knows it's ~30 m and still wants slope coloured \u2014 it's the only
    //   relief signal available there. Allow it.
    // - `aws-emergency-parent` is the transient-failure fallback INSIDE a
    //   LiDAR region (cold load, IGN/Swiss queue saturation). Painting a
    //   slope from a 30 m AWS pixel under the "0.40 m LIDAR" / "1 m LIDAR"
    //   label is misleading because LiDAR is supposed to be available;
    //   skip until the LiDAR pipeline lands and the DEM upgrades. The
    //   transparent response is not cached, so the next slope request
    //   recomputes against the upgraded DEM tile.
    // - `mapbox` is the legacy global path; same reasoning as the
    //   emergency parent (only ever set as a fallback inside a covered
    //   region today).
    const demSource = (demResponse.headers.get('X-DEM-Source') || '').toLowerCase();
    const isMisleadingSource =
      demSource.startsWith('aws-emergency') ||
      demSource.startsWith('mapbox');
    if (isMisleadingSource) {
      return transparentTileResponse();
    }

    try {
      const demBlob = await demResponse.clone().blob();
      if (isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }

      // ── Build path selection: worker pool first, in-process fallback ──
      // The pool offloads the pure Horn + sqrt-gamma encode + PNG encode
      // loop to dedicated Workers so the SW thread stays free for the
      // IGN fetch / CacheStorage / neighbour-DEM work that the next slope
      // tile in the burst needs. If the pool isn't available (older
      // browser, Worker spawn failure) OR the pool job was cancelled,
      // fall through to the in-process buildSlopeTile() — the result is
      // byte-identical because both share slope-math.js.
      let slopeResult = null;
      let usedPool = false;
      if (typeof computeSlopeViaPool === 'function') {
        try {
          const poolResult = await computeSlopeViaPool(
            demBlob, demCache, z, x, y, resFactor, demProfile, generation,
          );
          if (poolResult) {
            slopeResult = {
              blob: poolResult.blob,
              missingNeighbours: poolResult.missingDirections.map((dir) => {
                // Map direction names back to the [dx, dy] neighbour coords
                // the existing scheduleSlopeNeighbourWarm expects.
                if (dir === 'north') return [x, y - 1];
                if (dir === 'east')  return [x + 1, y];
                if (dir === 'south') return [x, y + 1];
                if (dir === 'west')  return [x - 1, y];
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
          () => buildSlopeTile(demBlob, z, x, y, demCache, resFactor, demProfile),
          generation,
        );
      }

      if (!slopeResult || isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }
      if (isSlopeWorkCancelled(generation)) {
        return transparentTileResponse();
      }
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
      if (!isSlopeWorkCancelled(generation)) {
        slopeCache.put(cacheKey, response.clone());
        // Promote the freshly built tile into the slope hot tier so an
        // immediate re-request (Mapbox repaint, resolution-toggle a
        // moment later, neighbour prewarm) returns in <1 ms.
        try {
          if (typeof slopeHotPut === 'function') {
            slopeHotPut(hotKey, slopeBlob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
      }

      // Seam self-heal happens after the visible tile is returned. The first
      // pass is fast and uses replicated own-tile edges where needed; the
      // delayed warmup triggers one debounced Mapbox reload once neighbour DEM
      // tiles are available, yielding seam-free borders without starving the
      // foreground burst.
      scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, slopeResult?.missingNeighbours, generation);
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
    if (SLOPE_INFLIGHT.get(inflightKey) === work) {
      SLOPE_INFLIGHT.delete(inflightKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Viewport / cross-profile slope prewarm (2026-06-20 multicore pass)
//
// Invoked by the SW message handler (PREWARM_SLOPE) when (a) the page
// detects an imminent resolution switch (so the OTHER profile's slope
// tiles are already in the cache when the user actually toggles) and
// (b) on idle to opportunistically warm the visible slope ring. Each
// prewarm is just a fire-and-forget handleSlopeRequest() — which already
// honours the hot tier + CacheStorage + pool + cancel-generation gates,
// so a prewarm that becomes stale (viewport moved) is dropped by the
// next CANCEL_SLOPE_WORK. We deliberately do NOT pass a `pf=1` tag here
// because these are real (not speculative) tiles that we want built and
// cached; the LIFO + slope-warm IGN priority already keeps them behind
// visible slope traffic.
//
// Concurrency is implicit: handleSlopeRequest dedups via SLOPE_INFLIGHT,
// so prewarming a tile that's already in-flight or cached is a no-op.
// ---------------------------------------------------------------------------
function prewarmSlopeTiles(tiles, profile) {
  if (!Array.isArray(tiles) || tiles.length === 0) return;
  const demProfile = profile === 'terrain' ? 'terrain' : 'default';
  // Cap the batch at 24 foreground tiles. Each prewarm tile still does a
  // DEM decode + neighbour lookups on the SW thread before the worker
  // pool takes over — running 64 of those in parallel saturates the SW
  // event loop and freezes the basemap DEM/ortho pipeline. 24 is roughly
  // one foreground screen worth and matches the page-side cap in useSlope.
  const batch = tiles.slice(0, 24);

  // SERIALISE the prewarm builds instead of firing all 24 in one tick.
  // handleSlopeRequest itself dedups via SLOPE_INFLIGHT, but the *entry*
  // of each call still opens caches + reads the DEM blob + decodes on the
  // SW thread. With Promise.all they all compete for the same microtask
  // graph and the SW can't service a real basemap fetch in between. The
  // serial chain yields to the event loop after each tile so a foreground
  // basemap request can preempt.
  let chain = Promise.resolve();
  for (const t of batch) {
    if (!t) continue;
    const z = t.z | 0;
    const x = t.x | 0;
    const y = t.y | 0;
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (z < 0 || x < 0 || y < 0) continue;
    chain = chain
      .then(() => handleSlopeRequest(z, x, y, '', demProfile))
      .catch(() => { /* best-effort */ });
  }
}
