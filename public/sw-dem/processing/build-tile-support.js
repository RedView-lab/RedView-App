// ---------------------------------------------------------------------------
// Shared helpers of the IGN DEM tile builds (build-tile.js, build-fallback-tile.js,
// build-terrain-tile.js): MNS area negative cache, France MNS post-processing,
// cancel-aware raster fetches and the provisional / cancelled build results.
// ---------------------------------------------------------------------------

// Area-level MNS negative cache — remembers Mercator tile regions where MNS
// returned 0 coverage with all permanent 404s. Adjacent tiles share the same
// IGN sub-tiles, so skipping MNS for known-empty areas saves 4-8 s per tile.
// TTL: 30 min. Map key: "z/x/y" at the demZ level (clamped zoom), which
// groups nearby Mercator tiles that map to the same IGN sub-tile grid.
const mnsAreaNegCache = new Map();
const MNS_AREA_NEG_TTL = 30 * 60_000; // 30 min

function mnsAreaNegKey(z, x, y) {
  // Group at z14 granularity (IGN_DEM_MAXZOOM clamp point) so adjacent
  // Mercator tiles at z15-17 that map to the same z14 IGN sub-tiles share
  // one negative cache entry.
  const groupZ = Math.min(z, IGN_DEM_MAXZOOM);
  const shift = z - groupZ;
  return `${groupZ}/${x >> shift}/${y >> shift}`;
}

function mnsAreaNegGet(z, x, y) {
  const key = mnsAreaNegKey(z, x, y);
  const entry = mnsAreaNegCache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts < MNS_AREA_NEG_TTL) return true;
  mnsAreaNegCache.delete(key);
  return false;
}

function mnsAreaNegSet(z, x, y) {
  const key = mnsAreaNegKey(z, x, y);
  mnsAreaNegCache.set(key, { ts: Date.now() });
  // Evict if too large
  if (mnsAreaNegCache.size > 500) {
    const iter = mnsAreaNegCache.keys();
    for (let i = 0; i < 200; i++) {
      const k = iter.next().value;
      if (k !== undefined) mnsAreaNegCache.delete(k);
    }
  }
}

function postProcessFranceMnsTile(elevations, coverage, mercZ) {
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  if (mercZ <= IGN_MNS_MIDZOOM_SMOOTH_MAXZOOM) {
    smoothSurfaceMicroUndulations(
      elevations,
      coverage,
      DEM_TILE_SIZE,
      IGN_MNS_MIDZOOM_SMOOTH_VARIANCE_M,
    );
  }
}

// A cancelled IGN raster fetch (IGN_FETCH_CANCELLED) says nothing about the
// tile: it is either fetched again — the tile is still wanted — or the build
// gives up with a `cancelled` result that the callers never commit. Falling
// through to the next source instead (correlation MNS, RGE ALTI, AWS 30 m)
// cached a degraded tile for good whenever a gesture or a queue flush hit a
// tile still on screen.
const IGN_CANCEL_RETRY_MAX_MAP = 6;
const IGN_CANCEL_RETRY_MAX_OTHER = 2;

async function fetchIgnRasterThroughCancels(fetchOnce, purpose, mapTile) {
  let result = await fetchOnce();
  for (let attempt = 0; result === IGN_FETCH_CANCELLED; attempt++) {
    // Speculative work (prefetch, warm-ups) is not worth a second request.
    if (isIGNBackgroundPurpose(purpose)) break;
    if (mapTile) {
      if (attempt >= IGN_CANCEL_RETRY_MAX_MAP || !isMapDemTileWanted(mapTile)) break;
    } else if (attempt >= IGN_CANCEL_RETRY_MAX_OTHER) {
      break;
    }
    result = await fetchOnce();
  }
  return result;
}

// A buildIGNTile() surface that is not the LiDAR HD WMS answer although the
// WMS never confirmed a coverage gap: the legacy correlation-MNS path ran
// because the WMS failed transiently. Provisional, never a final tile.
function isProvisionalMnsBuild(result, mercZ, mercX, mercY) {
  return Boolean(result?.elevations)
    && result.source !== 'ign-lidar-hd-wms'
    && typeof isMnsWmsConfirmedEmpty === 'function'
    && !isMnsWmsConfirmedEmpty(mercZ, mercX, mercY);
}

function cancelledIgnBuild() {
  return {
    blob: null, elevations: null, coverage: null,
    source: 'ign-cancelled', cancelled: true, allPermanent404: false, pendingFetches: null,
  };
}

// `mapTile` ({ key, requestedAt }): set when the map itself requested this
