// ---------------------------------------------------------------------------
// Slope Tile Processing — Tile Builders (zone HD tiles, ancestor upsamples)
// ---------------------------------------------------------------------------

const zoneStateMap = new Map();
const zonePreviewMap = new Map();
const backgroundHdSlopeInflight = new Map();

async function purgeSlopeCache(zoneHash) {
  try {
    if (typeof slopeHotClear === 'function') {
      slopeHotClear();
    }
    const slopeCache = await caches.open(SLOPE_CACHE_NAME);
    if (zoneHash) {
      zonePreviewMap.delete(zoneHash);
      const keys = await slopeCache.keys();
      const zoneSub = `zone=${zoneHash}`;
      const toDelete = [];
      for (const req of keys) {
        if (req.url.includes(zoneSub)) {
          toDelete.push(slopeCache.delete(req));
        }
      }
      await Promise.all(toDelete);
    } else {
      zonePreviewMap.clear();
      const keys = await slopeCache.keys();
      await Promise.all(keys.map((k) => slopeCache.delete(k)));
    }
    logDemPente(`🧹 Purge du cache des pentes effectuée (zone=${zoneHash || 'ALL'})`);
  } catch (err) {
    console.warn('[slope-purge]', err);
  }
}

// Zone pipeline (slope-zone-pipeline.js): one z14 tile at native resolution,
// masked to the analysis-zone polygon, cached under its `?zone=` key.
function buildAndCacheHdSlopeTile(z, x, y, resFactor, demProfile, zoneHash, options = {}) {
  const key = `${demProfile}:${z}/${x}/${y}?${zoneHash}`;
  if (backgroundHdSlopeInflight.has(key)) {
    return backgroundHdSlopeInflight.get(key);
  }

  const generation = zoneHash ? null : slopeCancelGeneration;
  const task = (async () => {
    const t0 = performance.now();
    try {
      if (zoneHash) {
        const { entry: zoneEntry } = resolveAnalysisZoneForTile(zoneHash);
        if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
          return transparentTileResponse();
        }
      }

      const demCache = await caches.open(CACHE_NAME);
      const demResp = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache, options?.sourceDem);

      if (!demResp || demResp.status !== 200 || (generation !== null && isSlopeWorkCancelled(generation))) {
        return transparentTileResponse();
      }

      const demBlob = await demResp.clone().blob();
      if (!demBlob || (generation !== null && isSlopeWorkCancelled(generation))) {
        return transparentTileResponse();
      }

      const slopeCache = await caches.open(SLOPE_CACHE_NAME);
      const { ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
      const ownSourceClass = slopeDemSourceClass(demResp.headers.get('X-DEM-Source'));

      const slopeResult = await buildSlopeBlobFromDem(
        demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing,
        options?.sourceDem, ownSourceClass, 1,
      );
      if (!slopeResult || !slopeResult.blob || (generation !== null && isSlopeWorkCancelled(generation))) {
        return transparentTileResponse();
      }

      const params = new URLSearchParams();
      if (resFactor > 1) params.set('res', String(resFactor));
      if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
      if (zoneHash) params.set('zone', zoneHash);
      const cacheKeyUrl = `/slope-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`;
      const cacheKey = new Request(cacheKeyUrl);
      const hotKey = `${demProfile}:${cacheKeyUrl}`;

      const response = new Response(slopeResult.blob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800',
          'X-Tile-Type': 'slope',
          'X-Slope-Quality': 'hd',
          'X-DEM-Profile': demProfile,
        },
      });

      // Provisional (seam-incomplete) builds stay out of both tiers: a hot
      // entry would be served back instead of the rebuild once the
      // neighbours exist.
      if (slopeResult.missingNeighbours.length === 0) {
        await slopeCache.put(cacheKey, response.clone());
        try {
          if (typeof slopeHotPut === 'function') {
            slopeHotPut(hotKey, slopeResult.blob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
      }

      if (z === 14 && zoneHash && !options?.silent) {
        invalidateParentDownsampledSlopeTiles(z, x, y, zoneHash);
      }

      const dt = Math.round(performance.now() - t0);
      logDemPente(`✨ Succès HD pour ${z}/${x}/${y} en ${dt}ms`);
      return response;
    } catch (err) {
      logDemPente(`❌ Erreur buildAndCacheHdSlopeTile ${z}/${x}/${y}: ${err?.message || err}`);
      return transparentTileResponse();
    } finally {
      backgroundHdSlopeInflight.delete(key);
    }
  })();

  backgroundHdSlopeInflight.set(key, task);
  return task;
}

// ── Slope tile from an ancestor slope tile ────────────────────────────
// Bilinear crop + upsample of an already-built SLOPE tile — never of the
// DEM, which would reintroduce the interpolation ripples the Horn kernel
// amplifies. Used where the exact DEM tile does not exist:
//   * outside the HD footprints above the global 30 m native zoom
//     (buildUpsampledGlobalSlopeResponse),
//   * where the terrain itself shows a parent mesh (buildSlopeFromAncestorDem).

const upsampleAncestorDecodeCache = new Map();
const UPSAMPLE_ANCESTOR_DECODE_MAX = 8;

function isSlopeTileResponse(resp) {
  return Boolean(resp && resp.status === 200 && resp.headers.get('X-Tile-Type') === 'slope');
}

async function decodeSlopeAncestorPixels(key, blob) {
  const hit = upsampleAncestorDecodeCache.get(key);
  if (hit) {
    upsampleAncestorDecodeCache.delete(key);
    upsampleAncestorDecodeCache.set(key, hit);
    return hit;
  }
  const img = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  let decoded;
  try {
    const size = img.width;
    if (img.height !== size || size < 2) return null;
    const ctx = typeof getSharedOffscreenCtx === 'function'
      ? getSharedOffscreenCtx(size, size)
      : new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0);
    decoded = { pixels: ctx.getImageData(0, 0, size, size).data, size };
  } finally {
    img.close();
  }
  upsampleAncestorDecodeCache.set(key, decoded);
  if (upsampleAncestorDecodeCache.size > UPSAMPLE_ANCESTOR_DECODE_MAX) {
    upsampleAncestorDecodeCache.delete(upsampleAncestorDecodeCache.keys().next().value);
  }
  return decoded;
}

// Bilinear, alpha-weighted (NoData pixels never bleed into valid ones) on
// the sqrt-gamma gray channel, sampled at pixel centres so adjacent children
// line up exactly. `src` is RGBA (decoded PNG) of srcSize², the output covers
// child (subX, subY) of the 2^dz × 2^dz grid at outSize².
function upsampleSlopeAncestor(src, srcSize, dz, subX, subY, outSize) {
  const scale = srcSize / (2 ** dz * outSize);
  const gray = new Uint8Array(outSize * outSize);
  const alpha = new Uint8Array(outSize * outSize);
  const last = srcSize - 1;
  for (let oy = 0; oy < outSize; oy++) {
    const sy = Math.min(Math.max((subY * outSize + oy + 0.5) * scale - 0.5, 0), last);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, last);
    const fy = sy - y0;
    for (let ox = 0; ox < outSize; ox++) {
      const sx = Math.min(Math.max((subX * outSize + ox + 0.5) * scale - 0.5, 0), last);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, last);
      const fx = sx - x0;
      const i00 = (y0 * srcSize + x0) * 4;
      const i01 = (y0 * srcSize + x1) * 4;
      const i10 = (y1 * srcSize + x0) * 4;
      const i11 = (y1 * srcSize + x1) * 4;
      const w00 = (1 - fx) * (1 - fy) * src[i00 + 3];
      const w01 = fx * (1 - fy) * src[i01 + 3];
      const w10 = (1 - fx) * fy * src[i10 + 3];
      const w11 = fx * fy * src[i11 + 3];
      const wSum = w00 + w01 + w10 + w11;
      if (wSum <= 0) continue; // transparent
      const o = oy * outSize + ox;
      gray[o] = Math.round((src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11) / wSum);
      alpha[o] = Math.round(wSum);
    }
  }
  return { gray, alpha };
}

async function upsampleSlopeFromAncestor(ancestorResponse, decodeKey, dz, subX, subY, outSize) {
  const ancestorBlob = await ancestorResponse.blob();
  // Size in the key: a provisional and a final ancestor build differ.
  const decoded = await decodeSlopeAncestorPixels(`${decodeKey}:${ancestorBlob.size}`, ancestorBlob);
  if (!decoded) return null;
  const { gray, alpha } = upsampleSlopeAncestor(decoded.pixels, decoded.size, dz, subX, subY, outSize);
  return alpha.every((a) => a === 255)
    ? buildGrayPng(outSize, outSize, gray)
    : buildGrayAlphaPng(outSize, outSize, gray, alpha);
}

// ── Global slope above its native zoom ────────────────────────────────
// Outside the high-resolution DEM footprints the slope is computed at
// GLOBAL_SLOPE_NATIVE_MAX_Z from AWS 30 m and the deeper tiles are an
// upsample of that slope raster. This is what Mapbox overzoom does in the
// 30 m mode, done in the SW so the HD source (maxzoom 16) keeps showing
// slope at every zoom.
async function buildUpsampledGlobalSlopeResponse(z, x, y, resParam, cacheKey, hotKey, slopeCache) {
  const dz = z - GLOBAL_SLOPE_NATIVE_MAX_Z;
  const ax = x >> dz;
  const ay = y >> dz;
  const ancestor = await handleSlopeRequest(GLOBAL_SLOPE_NATIVE_MAX_Z, ax, ay, resParam, 'default', '', { sourceDem: 'fast-30m' });
  if (!isSlopeTileResponse(ancestor)) {
    noteSlopeTileStale(hotKey);
    return transparentTileResponse();
  }
  const ancestorComplete = ancestor.headers.get('X-Slope-Seam') === 'complete'
    && !/no-cache/.test(ancestor.headers.get('Cache-Control') || '');

  const mask = (1 << dz) - 1;
  const blob = await upsampleSlopeFromAncestor(
    ancestor,
    `30m:${GLOBAL_SLOPE_NATIVE_MAX_Z}/${ax}/${ay}:${resParam || ''}`,
    dz, x & mask, y & mask,
    DEM_TILE_SIZE * SLOPE_OUTPUT_SCALE,
  );
  if (!blob) {
    noteSlopeTileStale(hotKey);
    return transparentTileResponse();
  }

  const response = new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': ancestorComplete ? 'public, max-age=604800' : 'no-cache',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': 'global-30m-upsampled',
      'X-Slope-Seam': ancestorComplete ? 'complete' : 'provisional',
      'X-DEM-Profile': 'fast-30m',
    },
  });
  if (ancestorComplete) {
    slopeCache.put(cacheKey, response.clone());
    try {
      if (typeof slopeHotPut === 'function') {
        slopeHotPut(hotKey, blob, Array.from(response.headers.entries()));
      }
    } catch { /* ignore */ }
    noteSlopeTileFinal(hotKey);
  } else {
    noteSlopeTileStale(hotKey);
  }
  return response;
}

// ── No DEM tile: the parent's slope ───────────────────────────────────
// The DEM pipeline answered 204 for this tile (LiDAR pending at high zoom,
// coverage gap, transient build failure): the terrain renders its parent
// mesh there. Show that parent's slope instead of a hole — the closest
// ancestor whose DEM is already available (never built from here), cropped
// and upsampled. The caller serves it provisional and waits on the real DEM.
async function buildSlopeFromAncestorDem(z, x, y, resParam, demProfile, sourceDem, demCache, outSize) {
  for (let dz = 1; dz <= 4 && z - dz >= 0; dz++) {
    const pZ = z - dz;
    const px = x >> dz;
    const py = y >> dz;
    const dem = await getExistingTerrainDemResponse(pZ, px, py, demProfile, demCache, sourceDem, { allowBuild: false });
    // A short-cached stand-in would make the ancestor's slope request rebuild it.
    if (!dem || dem.headers.get('x-cache-ttl-ms')) continue;
    const ancestor = await handleSlopeRequest(pZ, px, py, resParam, demProfile, '', {
      sourceDem,
      noAncestorFallback: true,
    });
    if (!isSlopeTileResponse(ancestor)) continue;
    const mask = (1 << dz) - 1;
    const blob = await upsampleSlopeFromAncestor(
      ancestor,
      `${sourceDem || 'hd'}:${demProfile}:${pZ}/${px}/${py}:${resParam || ''}`,
      dz, x & mask, y & mask, outSize,
    );
    if (blob) return blob;
  }
  return null;
}
