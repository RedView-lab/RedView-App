// ---------------------------------------------------------------------------
// DEM tile health-guard — rejects nodata-like or anomalously offset tiles
// before they are committed to the positive cache. When rejected, attempts
// a single parent-overzoom recovery. See sw-dem.js header for context.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

const DEM_HEALTH_MIN_PARENT_RANGE_M = 40;
const DEM_HEALTH_MIN_COLLAPSED_RANGE_M = 4;
const DEM_HEALTH_MAX_MEAN_DELTA_M = 180;
const DEM_HEALTH_VERTICAL_OFFSET_M = 180;
const DEM_HEALTH_NODATA_MEAN_M = -8000;

function summarizeDemElevations(elevations) {
  if (!elevations?.length) {
    return {
      valid: false,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      range: Number.NaN,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let index = 0; index < elevations.length; index += 1) {
    const value = elevations[index];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    count += 1;
  }

  if (count === 0) {
    return {
      valid: false,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      range: Number.NaN,
    };
  }

  return {
    valid: true,
    min,
    max,
    mean: sum / count,
    range: max - min,
  };
}

async function guardDemTileHealth(cache, pngBlob, z, x, y, demSource, demProfile) {
  if (!pngBlob || z < 8) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  let currentElevations;
  try {
    currentElevations = await decodeTerrainRGBBlob(pngBlob);
  } catch (error) {
    console.warn(`[sw-dem][health] decode failed ${z}/${x}/${y} src=${demSource}`, error);
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'decode-failed' };
  }

  const current = summarizeDemElevations(currentElevations);
  if (!current.valid) {
    console.warn(`[sw-dem][health] invalid stats ${z}/${x}/${y} src=${demSource}`);
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'invalid-stats' };
  }

  if (current.max <= -9000 || current.mean <= DEM_HEALTH_NODATA_MEAN_M) {
    const recovered = await tryParentOverzoom(cache, z, x, y, 0, demProfile);
    if (recovered?.blob) {
      console.warn(
        `[sw-dem][health] rejecting nodata-like tile ${z}/${x}/${y} src=${demSource} mean=${current.mean.toFixed(1)} -> ${recovered.source}`,
      );
      return {
        blob: recovered.blob,
        demSource: `${recovered.source}-healthguard`,
        shortCache: true,
        healthStatus: 'recovered',
      };
    }
    return { blob: null, demSource, shortCache: true, healthStatus: 'suspect', reason: 'nodata-like' };
  }

  const parentFallback = await tryParentOverzoom(cache, z, x, y, 0, demProfile);
  if (!parentFallback?.blob) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  let parentElevations;
  try {
    parentElevations = await decodeTerrainRGBBlob(parentFallback.blob);
  } catch {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  const parent = summarizeDemElevations(parentElevations);
  if (!parent.valid) {
    return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
  }

  const meanDelta = Math.abs(current.mean - parent.mean);
  const collapsedRangeThreshold = Math.max(DEM_HEALTH_MIN_COLLAPSED_RANGE_M, parent.range * 0.15);
  const collapsedRelief = parent.range >= DEM_HEALTH_MIN_PARENT_RANGE_M && current.range <= collapsedRangeThreshold;
  const verticalDrop = current.max < parent.min - DEM_HEALTH_VERTICAL_OFFSET_M;
  const verticalRise = current.min > parent.max + DEM_HEALTH_VERTICAL_OFFSET_M;
  const hugeOffset = meanDelta >= DEM_HEALTH_MAX_MEAN_DELTA_M;

  if (verticalDrop || verticalRise || (collapsedRelief && hugeOffset)) {
    console.warn(
      `[sw-dem][health] rejecting anomalous tile ${z}/${x}/${y} src=${demSource} current=[${current.min.toFixed(1)}..${current.max.toFixed(1)}] parent=[${parent.min.toFixed(1)}..${parent.max.toFixed(1)}] meanDelta=${meanDelta.toFixed(1)} -> ${parentFallback.source}`,
    );
    return {
      blob: parentFallback.blob,
      demSource: `${parentFallback.source}-healthguard`,
      shortCache: true,
      healthStatus: 'recovered',
    };
  }

  return { blob: pngBlob, demSource, shortCache: false, healthStatus: 'ok' };
}
