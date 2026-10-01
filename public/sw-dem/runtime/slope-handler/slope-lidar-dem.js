// ---------------------------------------------------------------------------
// Slope Tile Processing — DEM resolver (reads the 3D terrain's DEM tiles)
//
// The overlay requests exactly the tiles of the terrain's DEM pyramid
// (slope-source.ts, TERRAIN_ALIGNED_RASTER_TILE_SIZE), so a slope tile is
// computed from the DEM tile the terrain mesh already loaded: hot tier,
// CacheStorage, or the terrain's own in-flight build. A slope tile builds a
// DEM tile itself only on a genuine miss (explicit 0.40 m / 1 m choice that
// differs from the 3D profile, pitched-view LOD band); neighbours are never
// built. The 30 m path reads AWS Terrarium directly (free CDN, coalesced).
// ---------------------------------------------------------------------------

const FAST30M_DEM_INFLIGHT = new Map();

function demHeaderValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (Array.isArray(headers)) {
    const lower = name.toLowerCase();
    const entry = headers.find(([k]) => String(k).toLowerCase() === lower);
    return entry ? entry[1] : null;
  }
  return null;
}

// IGN is the only source whose surface (MNS) and bare-earth (MNT) builds
// differ; AWS, Swiss, Norway and Spain tiles are the same in both profiles.
function isDemProfileAgnosticSource(source) {
  return !/ign/i.test(source || '');
}

async function fetchFast30mDemResponse(z, x, y, demCache) {
  const awsKey = new Request(`/dem-tiles/${z}/${x}/${y}?rv-dem-profile=fast-30m`);
  const hot = demHotGet(awsKey.url);
  if (hot) return demHotResponse(hot);
  if (demCache) {
    const cached = await demCache.match(awsKey);
    if (cached && cached.status === 200) {
      try { demHotPut(awsKey.url, await cached.clone().blob(), Array.from(cached.headers.entries())); } catch { /* ignore */ }
      return cached;
    }
  }
  if (typeof fetchAWSTerrainTile !== 'function') return null;
  // Coalesced: a 30 m DEM tile is both an own tile and up to four
  // neighbours of concurrently built slope tiles.
  const inflightKey = `${z}/${x}/${y}`;
  let pending = FAST30M_DEM_INFLIGHT.get(inflightKey);
  if (!pending) {
    pending = (async () => {
      const blob = await fetchAWSTerrainTile(z, x, y);
      if (!blob) return null;
      const headers = {
        'Content-Type': 'image/png',
        'X-DEM-Source': 'aws-fast-30m',
        'X-DEM-Health': 'ok',
      };
      try { demHotPut(awsKey.url, blob, Object.entries(headers)); } catch { /* ignore */ }
      if (demCache) {
        try { await demCache.put(awsKey, new Response(blob, { status: 200, headers })); } catch { /* ignore */ }
      }
      return { blob, headers };
    })().finally(() => FAST30M_DEM_INFLIGHT.delete(inflightKey));
    FAST30M_DEM_INFLIGHT.set(inflightKey, pending);
  }
  const built = await pending;
  return built ? new Response(built.blob, { status: 200, headers: built.headers }) : null;
}

// The terrain's own build of this tile, when one is running.
async function awaitInflightTerrainDem(z, x, y, demProfile) {
  if (typeof DEM_INFLIGHT === 'undefined' || !DEM_INFLIGHT) return null;
  const inflight = DEM_INFLIGHT.get(`${demProfile}:${z}/${x}/${y}`);
  if (!inflight) return null;
  try {
    const resp = await inflight;
    return resp && resp.status === 200 ? resp.clone() : null;
  } catch {
    return null;
  }
}

// opts.allowBuild (default true): when false, only already-available DEM
// (hot tier / CacheStorage / in-flight terrain build) is returned — a miss
// resolves to null (or to a short-cached stand-in) instead of starting a new
// DEM build. The 30 m AWS branch ignores it (AWS tiles are cheap).
async function getExistingTerrainDemResponse(z, x, y, demProfile, demCache, sourceDem = '', opts = {}) {
  const allowBuild = opts.allowBuild !== false;
  if (sourceDem === 'fast-30m' || demProfile === 'fast-30m') {
    // Fast-30m strictly uses AWS Terrarium; never falls through to IGN.
    return fetchFast30mDemResponse(z, x, y, demCache);
  }

  // 1. Hot tier — finalize() only promotes final tiles.
  const key = buildDemCacheKey(z, x, y, demProfile);
  const hot = demHotGet(key.url);
  if (hot) return demHotResponse(hot);

  // 2. CacheStorage. A short-cached stand-in (parent overzoom, AWS emergency)
  // is NOT the answer: handleDemRequest() checks its TTL and rebuilds the
  // real tile once it expires — returning it here used to pin the slope on
  // the stand-in forever.
  let standIn = null;
  if (demCache) {
    const cached = await demCache.match(key);
    if (cached && cached.status === 200) {
      if (!cached.headers.get('x-cache-ttl-ms')) return cached;
      standIn = cached;
    }
  }

  // 3. The terrain is building this very tile right now.
  const inflight = await awaitInflightTerrainDem(z, x, y, demProfile);
  if (inflight) return inflight;

  // 4. The other profile's tile, only where both profiles are identical. The
  // old unconditional fallback put buildings into the "1 m terrain" slope
  // whenever the 3D ran on the 0.40 m surface.
  if (demProfile !== 'default') {
    const other = demHotGet(buildDemCacheKey(z, x, y, 'default').url);
    if (other && isDemProfileAgnosticSource(demHeaderValue(other.headers, 'X-DEM-Source'))) {
      return demHotResponse(other);
    }
  }

  // 5. Build it — shared with the terrain through DEM_INFLIGHT.
  if (!allowBuild) return standIn;
  try {
    if (typeof handleDemRequest === 'function') {
      const built = await handleDemRequest(key, z, x, y, 0, demProfile);
      if (built && built.status === 200) return built;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Neighbour DEMs (Horn + interpolation border) ──────────────────────

const SLOPE_NEIGHBOUR_DIRECTIONS = [
  ['north', 0, -1],
  ['east', 1, 0],
  ['south', 0, 1],
  ['west', -1, 0],
];

function shouldUseSlopeNeighbourDem(resp, demProfile, sourceDem = '', ownSourceClass = '') {
  if (!resp) return false;
  if (typeof resp.status === 'number' && resp.status !== 200) return false;
  const health = (demHeaderValue(resp.headers, 'X-DEM-Health') || 'ok').toLowerCase();
  if (health !== 'ok') return false;
  const source = (demHeaderValue(resp.headers, 'X-DEM-Source') || '').toLowerCase();

  // Strict DEM source segregation: NEVER mix 30m AWS DEM with high-res LiDAR DEM!
  if (sourceDem === 'fast-30m') {
    return source.startsWith('aws');
  }
  // HD: stitch only against the same DEM class as the own tile.
  const neighbourIsAws = source === 'aws-fast-30m' || source.startsWith('aws-terrarium');
  if (neighbourIsAws !== (ownSourceClass === 'aws')) return false;
  if (
    source.startsWith('aws-emergency')
    || source.startsWith('mapbox')
    || source.startsWith('overzoom')
  ) {
    return false;
  }
  return true;
}

/**
 * The four cardinal neighbour DEMs of a slope tile, from what the terrain
 * already has: hot tier, CacheStorage, or its in-flight build — awaited,
 * since the viewport's tiles are built together and waiting is what makes a
 * tile seam-complete on first paint. A neighbour the terrain never asked for
 * (outside the viewport) is not built: the tile is served provisional and
 * rebuilt when that DEM lands (waitSlopeTileOnDem). The 30 m path fetches
 * the AWS neighbour instead.
 *
 * Returns { blobs: {north…west: Blob|null}, missing: [[x, y]], standIns: [[x, y]] }
 * — `standIns` are used but short-cached (the tile is not final yet).
 */
async function resolveSlopeNeighbourDems(z, x, y, demProfile, demCache, sourceDem, ownSourceClass) {
  const n = 2 ** z;
  const blobs = { north: null, east: null, south: null, west: null };
  const missing = [];
  const standIns = [];
  await Promise.all(SLOPE_NEIGHBOUR_DIRECTIONS.map(async ([dir, dx, dy]) => {
    const ny = y + dy;
    if (ny < 0 || ny >= n) return; // beyond the poles: nothing to wait for
    const nx = (x + dx + n) % n; // the antimeridian wraps
    try {
      const resp = sourceDem === 'fast-30m'
        ? await fetchFast30mDemResponse(z, nx, ny, demCache)
        : await getExistingTerrainDemResponse(z, nx, ny, demProfile, demCache, sourceDem, { allowBuild: false });
      if (!shouldUseSlopeNeighbourDem(resp, demProfile, sourceDem, ownSourceClass)) {
        missing.push([nx, ny]);
        return;
      }
      blobs[dir] = await resp.blob();
      if (resp.headers.get('x-cache-ttl-ms')) standIns.push([nx, ny]);
    } catch {
      missing.push([nx, ny]);
    }
  }));
  return { blobs, missing, standIns };
}
