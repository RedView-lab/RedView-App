// ---------------------------------------------------------------------------
// Slope Tile Processing — Tile Builders (LiDAR HD & Downsampled for Zones)
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
      const demResp = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache);

      if (!demResp || demResp.status !== 200 || (generation !== null && isSlopeWorkCancelled(generation))) {
        return transparentTileResponse();
      }

      const demBlob = await demResp.clone().blob();
      if (!demBlob || (generation !== null && isSlopeWorkCancelled(generation))) {
        return transparentTileResponse();
      }

      const slopeCache = await caches.open(SLOPE_CACHE_NAME);
      const { ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);

      const slopeResult = await buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing);
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

      await slopeCache.put(cacheKey, response.clone());
      try {
        if (typeof slopeHotPut === 'function') {
          slopeHotPut(hotKey, slopeResult.blob, Array.from(response.headers.entries()));
        }
      } catch { /* ignore */ }

      if (z === 14 && zoneHash && !options?.silent) {
        invalidateParentDownsampledSlopeTiles(z, x, y, zoneHash);
      }

      const dt = Math.round(performance.now() - t0);
      logDemPente(`✨ Succès HD pour ${z}/${x}/${y} en ${dt}ms`);

      scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, slopeResult.missingNeighbours, generation);
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

async function buildDownsampledSlopeTile(z, x, y, resFactor, demProfile, zoneHash) {
  const S = DEM_TILE_SIZE;
  const dz = 14 - z;
  if (dz <= 0) return null;

  const { entry: zoneEntry } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash && (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y))) {
    return transparentTileResponse();
  }

  const scale = 1 << dz;
  const startChildX = x * scale;
  const startChildY = y * scale;
  const endChildX = startChildX + scale - 1;
  const endChildY = startChildY + scale - 1;

  const childTilesToFetch = [];
  for (let cx = startChildX; cx <= endChildX; cx++) {
    for (let cy = startChildY; cy <= endChildY; cy++) {
      if (!zoneEntry || tileIntersectsAnalysisZone(zoneEntry, 14, cx, cy)) {
        childTilesToFetch.push({ cx, cy });
      }
    }
  }

  if (childTilesToFetch.length === 0) {
    return transparentTileResponse();
  }

  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const childBlobs = new Map();

  await Promise.all(childTilesToFetch.map(async ({ cx, cy }) => {
    try {
      const childParams = new URLSearchParams();
      if (resFactor > 1) childParams.set('res', String(resFactor));
      if (demProfile === 'terrain') childParams.set('rv-dem-profile', 'terrain');
      if (zoneHash) childParams.set('zone', zoneHash);
      const childUrl = `/slope-tiles/14/${cx}/${cy}${childParams.size ? `?${childParams.toString()}` : ''}`;

      let blob = null;
      const cached = await slopeCache.match(new Request(childUrl));
      if (cached && cached.status === 200) {
        blob = await cached.clone().blob();
      }
      if (blob) {
        const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const ctx = (typeof getSharedOffscreenCtx === 'function')
          ? getSharedOffscreenCtx(S, S)
          : new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, S, S);
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, S, S);
        img.close();
        childBlobs.set(`${cx}/${cy}`, imgData.data);
      }
    } catch { /* ignore */ }
  }));

  if (childBlobs.size === 0) {
    return transparentTileResponse();
  }

  const outRgba = new Uint8Array(S * S * 4);
  for (let py = 0; py < S; py++) {
    const globalY = py * scale;
    const childTileOffsetY = Math.floor(globalY / S);
    const subPy = globalY % S;
    const cy = startChildY + childTileOffsetY;

    for (let px = 0; px < S; px++) {
      const globalX = px * scale;
      const childTileOffsetX = Math.floor(globalX / S);
      const subPx = globalX % S;
      const cx = startChildX + childTileOffsetX;

      const childKey = `${cx}/${cy}`;
      const childData = childBlobs.get(childKey);
      if (childData) {
        const childIdx = (subPy * S + subPx) * 4;
        const outIdx = (py * S + px) * 4;
        outRgba[outIdx] = childData[childIdx];
        outRgba[outIdx + 1] = childData[childIdx + 1];
        outRgba[outIdx + 2] = childData[childIdx + 2];
        outRgba[outIdx + 3] = childData[childIdx + 3];
      }
    }
  }

  const blob = (typeof buildRawPngSlope === 'function')
    ? await buildRawPngSlope(S, S, outRgba)
    : await buildRawPng(S, S, outRgba);

  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': 'hd',
      'X-DEM-Profile': demProfile,
    },
  });
}

async function buildOverzoomedSlopeTile(z, x, y, resFactor, demProfile, zoneHash) {
  const S = DEM_TILE_SIZE;
  const parentZ = z - 1;
  if (parentZ < 6) return transparentTileResponse();

  const parentX = Math.floor(x / 2);
  const parentY = Math.floor(y / 2);
  const subX = (x % 2) * (S / 2);
  const subY = (y % 2) * (S / 2);
  const subSize = S / 2;

  const parentResp = await handleSlopeRequest(parentZ, parentX, parentY, String(resFactor), demProfile, zoneHash);
  if (!parentResp || parentResp.status !== 200) {
    return transparentTileResponse();
  }

  const parentBlob = await parentResp.clone().blob();
  const img = await createImageBitmap(parentBlob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = (typeof getSharedOffscreenCtx === 'function')
    ? getSharedOffscreenCtx(S, S)
    : new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, subX, subY, subSize, subSize, 0, 0, S, S);
  img.close();
  const imgData = ctx.getImageData(0, 0, S, S);
  const blob = (typeof buildRawPngSlope === 'function')
    ? await buildRawPngSlope(S, S, imgData.data)
    : await buildRawPng(S, S, imgData.data);

  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': 'hd',
      'X-DEM-Profile': demProfile,
    },
  });
}
