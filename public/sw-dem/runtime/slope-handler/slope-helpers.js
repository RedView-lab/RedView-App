// ---------------------------------------------------------------------------
// Slope Tile Processing — Shared Helpers
// ---------------------------------------------------------------------------

const DEBUG_SLOPE = false;

// Native zoom of the global (AWS 30 m) slope. Same cap as the 30 m mode
// (slope-source.ts resolveSlopeMaxZoom): beyond it AWS Terrarium tiles are
// server-side upsampled and Horn turns the interpolation into hatching, so
// higher zooms reuse the z13 slope instead (see buildUpsampledGlobalSlopeResponse).
const GLOBAL_SLOPE_NATIVE_MAX_Z = 13;

// Deepest HD slope zoom (same as slope-source.ts): past it the national
// rasters are upsampled and Mapbox overzooms the z16 slope itself.
const HD_SLOPE_MAX_Z = 16;

// Terrain-aligned tiles are drawn over 1024–2048 CSS px for 256 DEM cells:
// the slope is upsampled 2× here with a smooth cubic (slope-math.js) so the
// GPU's bilinear magnification has 4× less to stretch. Zone tiles (z14
// pipeline) stay at native resolution.
const SLOPE_OUTPUT_SCALE = 2;

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

// ── Stale slope tiles → page-side source reload ───────────────────────
// A provisional slope tile (missing neighbour, stand-in DEM, ancestor
// fallback, transparent placeholder) is served but not cached; the page
// reloads the slope source on SLOPE_TILES_STALE (derived-tile-stale.js).
// A slope tile built while a cardinal neighbour DEM is not there yet (the
// terrain never asked for it: outside the viewport), or while its own DEM is
// a stand-in, waits on that DEM tile and comes back seam-complete once it
// lands.
const SLOPE_STALE_TRACKER = createDerivedTileStaleTracker('SLOPE_TILES_STALE');

function noteSlopeTileStale(tileKey, options) {
  SLOPE_STALE_TRACKER.noteStale(tileKey, options);
}

function noteSlopeTileFinal(tileKey) {
  SLOPE_STALE_TRACKER.noteFinal(tileKey);
}

function waitSlopeTileOnDem(tileKey, demProfile, z, tiles) {
  SLOPE_STALE_TRACKER.waitOnDem(tileKey, demProfile, z, tiles);
}

function isSlopeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== slopeCancelGeneration;
}

// Own DEM blob → slope PNG. Neighbours are resolved first (terrain tiles,
// in-flight builds awaited), then the job runs in the worker pool — or in
// process when the pool is unavailable.
//
// Returns { blob, missingNeighbours: [[x, y]], standInNeighbours: [[x, y]] }
// or null (cancelled / failed).
async function buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing, sourceDem = '', ownSourceClass = '', outputScale = 1) {
  const neighbours = await resolveSlopeNeighbourDems(z, x, y, demProfile, demCache, sourceDem, ownSourceClass);
  if (generation !== null && isSlopeWorkCancelled(generation)) return null;

  let slopeResult = null;
  if (typeof computeSlopeViaPool === 'function') {
    try {
      slopeResult = await computeSlopeViaPool(
        demBlob, neighbours.blobs, z, x, y, resFactor, generation, zoneRing, outputScale,
      );
    } catch {
      /* fall through to in-process */
    }
  }
  if (!slopeResult) {
    slopeResult = await scheduleSlopeBuild(
      () => buildSlopeTile(demBlob, neighbours.blobs, z, x, y, resFactor, demProfile, zoneRing, outputScale),
      generation,
    );
  }
  if (!slopeResult?.blob || (generation !== null && isSlopeWorkCancelled(generation))) return null;

  // A neighbour blob the worker failed to decode counts as missing too.
  const missingNeighbours = neighbours.missing.slice();
  const n = 2 ** z;
  const offsets = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  for (const dir of slopeResult.missingDirections || []) {
    if (!neighbours.blobs[dir] || !offsets[dir]) continue;
    missingNeighbours.push([(x + offsets[dir][0] + n) % n, y + offsets[dir][1]]);
  }
  return {
    blob: slopeResult.blob,
    missingNeighbours,
    standInNeighbours: neighbours.standIns,
  };
}

// ── HD coverage & DEM source classes ──────────────────────────────────

/**
 * True when a high-resolution national DEM (IGN France incl. overseas,
 * swissSURFACE3D, Norway DTM, Spain MDT) may cover the tile — i.e. the HD
 * slope pipeline has something better than AWS 30 m to work with. Uses the
 * same predicates as the DEM dispatcher (compute-request.js).
 */
async function slopeTileHasHdCoverage(z, x, y) {
  if (tileOverlapsOverseasFrance(z, x, y)) return true;
  if (tileOverlapsSwitzerland(z, x, y) || tileOverlapsNorway(z, x, y) || tileOverlapsSpain(z, x, y)) return true;
  if (!tileOverlapsFrance(z, x, y)) return false;
  // Polygon unavailable: keep the HD path (previous behaviour).
  if (!(await ensureFrancePoly())) return true;
  return classifyDemTile(z, x, y) !== 'outside';
}

/** 'aws' for the global 30 m DEM, 'hires' for every national high-res DEM. */
function slopeDemSourceClass(source) {
  const s = (source || '').toLowerCase();
  return (s === 'aws-fast-30m' || s.startsWith('aws-terrarium')) ? 'aws' : 'hires';
}
