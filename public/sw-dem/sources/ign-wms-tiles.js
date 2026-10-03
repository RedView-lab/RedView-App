// ---------------------------------------------------------------------------
// IGN WMS elevation tiles — 1 m terrain (LiDAR HD MNT) and 0.40 m MNS (LiDAR
// HD MNS) per Mercator tile, with their own LRU caches, TTL null caching and
// in-flight dedup. Raster geometry lives in ign-wms-raster.js.
// ---------------------------------------------------------------------------

const terrainWmsTileCache = new Map();
const terrainWmsInflight = new Map();
const TERRAIN_WMS_CACHE_MAX = 300;
const mnsWmsTileCache = new Map();
const mnsWmsInflight = new Map();
// Raw WMS grids only serve rebuilds of the same tile — the DEM hot tier and
// CacheStorage answer every normal re-request — so keep this small
// (96 × 256 KB ≈ 24 MB instead of ~77 MB of SW heap).
const MNS_WMS_CACHE_MAX = 96;

// Centre of a Mercator tile, used to schedule WMS fetches centre-first.
function mercatorTileCenterCoords(mercZ, mercX, mercY) {
  const b = mercatorTileBounds(mercZ, mercX, mercY);
  return { lng: (b.west + b.east) / 2, lat: (b.north + b.south) / 2 };
}

function getCachedTerrainWms(key) {
  if (!terrainWmsTileCache.has(key)) return { hit: false };
  const entry = terrainWmsTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    terrainWmsTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) {
    terrainWmsTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

function cacheTerrainWmsNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  terrainWmsTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

// Returns the resampled raster, null (no data / transient failure) or
// IGN_FETCH_CANCELLED. `mapTile`: see scheduleIGN().
async function getTerrainWmsTile(mercZ, mercX, mercY, purpose = PURPOSE_SLOPE_VISIBLE, mapTile = null) {
  const supersample = ignWmsSupersampleFactor(mercZ);
  const key = `wms-mnt/${mercZ}/${mercX}/${mercY}@${supersample}x`;
  const cached = getCachedTerrainWms(key);
  if (cached.hit) return cached.data;

  if (terrainWmsInflight.has(key)) return terrainWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedTerrainWms(key);
    if (cached2.hit) return cached2.data;

    const { controller, cleanup, init } = ignFetchInit({ purpose, mapTile });
    try {
      const { width: srcW, height: srcH } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
      // 1. LiDAR HD MNT (0.5 m bare earth), 2. RGE ALTI for the pixels it
      // does not cover. Both rasters share the exact request geometry, so
      // the gap fill is a per-pixel merge before the resample.
      let raw = await fetchWmsElevationRaster(IGN_LIDAR_MNT_LAYER, mercZ, mercX, mercY, supersample, init);
      let validCount = 0;
      if (raw) {
        for (let i = 0; i < raw.length; i++) if (isValidWmsElevation(raw[i])) validCount++;
      }
      if (validCount < srcW * srcH) {
        const rgeAlti = await fetchWmsElevationRaster(IGN_DEM_FALLBACK_LAYER, mercZ, mercX, mercY, supersample, init);
        if (rgeAlti) {
          if (!raw || validCount === 0) {
            raw = rgeAlti;
          } else {
            for (let i = 0; i < raw.length; i++) {
              if (!isValidWmsElevation(raw[i])) raw[i] = rgeAlti[i];
            }
          }
          validCount = 0;
          for (let i = 0; i < raw.length; i++) if (isValidWmsElevation(raw[i])) validCount++;
        }
      }
      if (!raw) {
        cacheTerrainWmsNull(key, 'transient');
        return null;
      }
      if (validCount === 0) return null;
      const data = mnsWmsResampleToTile(raw, srcW, srcH);
      evict(terrainWmsTileCache, TERRAIN_WMS_CACHE_MAX);
      terrainWmsTileCache.set(key, data);
      return data;
    } catch {
      if (isIGNUserCancel(controller)) return IGN_FETCH_CANCELLED;
      cacheTerrainWmsNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose, mercatorTileCenterCoords(mercZ, mercX, mercY), mapTile).then((result) => {
    if (result === PRUNED_SENTINEL) return IGN_FETCH_CANCELLED;
    return result;
  }).finally(() => {
    terrainWmsInflight.delete(key);
  });

  terrainWmsInflight.set(key, promise);
  return promise;
}

function getCachedMnsWms(key) {
  if (!mnsWmsTileCache.has(key)) return { hit: false };
  const entry = mnsWmsTileCache.get(key);
  if (entry instanceof Float32Array) return { hit: true, data: entry };
  if (entry && entry._null) {
    if (Date.now() - entry.ts < entry.ttl) return { hit: true, data: null };
    mnsWmsTileCache.delete(key);
    return { hit: false };
  }
  if (entry === null) {
    mnsWmsTileCache.delete(key);
    return { hit: false };
  }
  return { hit: true, data: entry };
}

function cacheMnsWmsNull(key, errorType) {
  const ttl = errorType === 'permanent' ? IGN_NULL_TTL_PERMANENT : IGN_NULL_TTL_TRANSIENT;
  mnsWmsTileCache.set(key, { _null: true, ts: Date.now(), ttl, errorType });
}

function mnsWmsCacheKey(mercZ, mercX, mercY) {
  return `mns/${mercZ}/${mercX}/${mercY}@${mnsWmsSupersampleFactor()}x`;
}

// True only when the LiDAR HD WMS answered for this tile with no valid sample
// (a genuine coverage gap) — never after a timeout, an abort or an HTTP error.
function isMnsWmsConfirmedEmpty(mercZ, mercX, mercY) {
  const key = mnsWmsCacheKey(mercZ, mercX, mercY);
  // getCachedMnsWms first: it drops an expired null entry.
  const cached = getCachedMnsWms(key);
  return cached.hit && !cached.data && mnsWmsTileCache.get(key)?.errorType === 'permanent';
}

// Returns the resampled raster, null (no data / transient failure) or
// IGN_FETCH_CANCELLED. `mapTile`: see scheduleIGN().
async function getMnsWmsTile(mercZ, mercX, mercY, purpose = null, mapTile = null) {
  const supersample = mnsWmsSupersampleFactor();
  const { width: srcW, height: srcH } = mnsWmsRequestSize(mercZ, mercX, mercY, supersample);
  const key = mnsWmsCacheKey(mercZ, mercX, mercY);
  const cached = getCachedMnsWms(key);
  if (cached.hit) return cached.data;

  if (mnsWmsInflight.has(key)) return mnsWmsInflight.get(key);

  const promise = scheduleIGN(async () => {
    const cached2 = getCachedMnsWms(key);
    if (cached2.hit) return cached2.data;

    // 1. Primary: True LiDAR HD MNS WMS (~0.40m surface model)
    const { controller, cleanup, init } = ignFetchInit({ purpose, mapTile });
    try {
      let data = null;
      let answered = false;
      try {
        // The request is deliberately NOT degree-square (see
        // mnsWmsRequestSize): srcW > srcH, box-averaged down to
        // DEM_TILE_SIZE² and de-combed in Y by mnsWmsResampleToTile, which is
        // NaN/range-aware (cells with no valid sample stay NaN).
        const raw = await fetchWmsElevationRaster(IGN_LIDAR_MNS_LAYER, mercZ, mercX, mercY, supersample, init);
        if (raw) {
          answered = true;
          const tiled = mnsWmsResampleToTile(raw, srcW, srcH);
          let tiledValid = 0;
          for (let i = 0; i < tiled.length; i++) if (isValidWmsElevation(tiled[i])) tiledValid++;
          if (tiledValid > 0) data = tiled;
        }
      } catch {
        if (isIGNUserCancel(controller)) return IGN_FETCH_CANCELLED;
      }

      // No WMS fallback to the HIGHRES / HIGHRES.MNS correlation layers.
      //
      // Those products are only ever served 2x upsampled in Y through any WMS
      // GetMap CRS: measured 128 distinct rows for a 256-row request, and the
      // duplicated rows do not sit in aligned pairs (the row sequence bounces
      // A,B,B,A over each 4-row block) so neither a larger request nor a 2x2
      // box average recovers the missing samples. The even/odd row-gradient
      // comb measured 0.70-1.23 — worse than the degree-square defect this file
      // just fixed for LiDAR HD — so the fallback raster would re-introduce
      // exactly the dash artefact on the slope overlay.
      //
      // Returning null instead lets buildIGNTile fall through to the legacy
      // WMTS path, which samples the product on its own WGS84G tile matrix and
      // therefore never resamples rows.
      if (data) {
        evict(mnsWmsTileCache, MNS_WMS_CACHE_MAX);
        mnsWmsTileCache.set(key, data);
        return data;
      }

      // A well-formed raster with no valid sample is a genuine LiDAR HD
      // coverage gap: remember it for longer than a transport failure so the
      // WMS request is not repeated every 10 s.
      cacheMnsWmsNull(key, answered ? 'permanent' : 'transient');
      return null;
    } catch {
      if (isIGNUserCancel(controller)) return IGN_FETCH_CANCELLED;
      cacheMnsWmsNull(key, 'transient');
      return null;
    } finally {
      cleanup();
    }
  }, purpose, mercatorTileCenterCoords(mercZ, mercX, mercY), mapTile).then((result) => {
    if (result === PRUNED_SENTINEL) return IGN_FETCH_CANCELLED;
    return result;
  }).finally(() => {
    mnsWmsInflight.delete(key);
  });

  mnsWmsInflight.set(key, promise);
  return promise;
}
