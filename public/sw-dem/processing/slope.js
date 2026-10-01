// ---------------------------------------------------------------------------
// Slope tile — in-process fallback (worker pool unavailable).
//
// The math (Horn on a padded buffer, sqrt-gamma encode, 2× Catmull-Rom,
// gray + alpha PNG) lives in workers/slope-math.js and is shared with the
// worker pool, so both paths produce byte-identical tiles. This file only
// decodes the DEM blobs on the SW thread, with a small LRU so a DEM tile
// read as the own tile of one slope tile and as the neighbour of four others
// is decoded once.
//
// Encoding (see slope-math.js / slope-source.ts):
//   gray  = round(sqrt(deg / 90) · 255)   — decoded GPU-side by raster-color-mix
//   alpha = 0 on NoData / outside the analysis zone, 255 otherwise
// Colours, hidden bands and the gradient/step mode are GPU paint properties:
// they never invalidate a tile.
// ---------------------------------------------------------------------------

const SLOPE_DECODED_DEM_CACHE_MAX = 384;
const slopeDecodedDemCache = new Map();
const slopeDecodedDemInflight = new Map();
let slopeDecodeCacheGeneration = 0;

function slopeDemDecodeKey(z, x, y, demProfile) {
  return `${demProfile || 'default'}:${z}/${x}/${y}`;
}

function rememberSlopeDecodedDem(key, elevations, generation) {
  if (!elevations) return elevations;
  if (generation !== slopeDecodeCacheGeneration) return elevations;
  if (slopeDecodedDemCache.has(key)) slopeDecodedDemCache.delete(key);
  slopeDecodedDemCache.set(key, elevations);
  while (slopeDecodedDemCache.size > SLOPE_DECODED_DEM_CACHE_MAX) {
    const oldest = slopeDecodedDemCache.keys().next().value;
    if (oldest === undefined) break;
    slopeDecodedDemCache.delete(oldest);
  }
  return elevations;
}

async function decodeSlopeDemBlob(demBlob, z, x, y, demProfile) {
  // The blob size tells two DEM versions of the same coords apart (stand-in
  // vs final build, 30 m vs LiDAR — both use the 'default' profile key).
  const key = `${slopeDemDecodeKey(z, x, y, demProfile)}:${demBlob?.size || 0}`;
  if (slopeDecodedDemCache.has(key)) {
    const cached = slopeDecodedDemCache.get(key);
    slopeDecodedDemCache.delete(key);
    slopeDecodedDemCache.set(key, cached);
    return cached;
  }
  if (slopeDecodedDemInflight.has(key)) return slopeDecodedDemInflight.get(key);

  const generation = slopeDecodeCacheGeneration;
  const work = decodeTerrainRGBBlob(demBlob)
    .then((elevations) => rememberSlopeDecodedDem(key, elevations, generation))
    .finally(() => slopeDecodedDemInflight.delete(key));
  slopeDecodedDemInflight.set(key, work);
  return work;
}

function clearSlopeProcessingCaches() {
  slopeDecodeCacheGeneration++;
  slopeDecodedDemCache.clear();
  slopeDecodedDemInflight.clear();
}

function invalidateSlopeProcessingTile(z, x, y) {
  slopeDecodeCacheGeneration++;
  const prefixes = [
    `${slopeDemDecodeKey(z, x, y, 'default')}:`,
    `${slopeDemDecodeKey(z, x, y, 'terrain')}:`,
  ];
  for (const map of [slopeDecodedDemCache, slopeDecodedDemInflight]) {
    for (const key of Array.from(map.keys())) {
      if (prefixes.some((p) => key.startsWith(p))) map.delete(key);
    }
  }
}

// `neighbourBlobs`: { north, east, south, west } DEM blobs already resolved
// by resolveSlopeNeighbourDems() (null when absent).
// Returns { blob, missingDirections } like the worker pool.
async function buildSlopeTile(demBlob, neighbourBlobs, z, x, y, resFactor, demProfile, zoneRing, outputScale) {
  const n = 2 ** z;
  const coords = {
    north: [x, y - 1],
    east: [(x + 1) % n, y],
    south: [x, y + 1],
    west: [(x - 1 + n) % n, y],
  };
  const ownElev = await decodeSlopeDemBlob(demBlob, z, x, y, demProfile);
  const neighbourElevations = {};
  await Promise.all(Object.keys(coords).map(async (dir) => {
    const blob = neighbourBlobs?.[dir];
    if (!blob) return;
    const [nx, ny] = coords[dir];
    try {
      neighbourElevations[dir] = await decodeSlopeDemBlob(blob, z, nx, ny, demProfile);
    } catch { /* treated as missing */ }
  }));
  return buildSlopePngFromElevations(ownElev, neighbourElevations, z, x, y, {
    resFactor,
    outputScale,
    zoneRing,
  });
}
