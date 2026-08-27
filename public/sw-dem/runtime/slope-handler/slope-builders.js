// ---------------------------------------------------------------------------
// Slope Tile Processing — Tile Builders (Low 30m, LiDAR HD, Downsampled)
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

async function buildAndCacheLowSlopeTile(z, x, y, resFactor, demProfile, zoneHash) {
  const { entry: zoneEntry, ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash && (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y))) {
    return transparentTileResponse();
  }

  const demCache = await caches.open(CACHE_NAME);
  const previewKey = `${zoneHash}:${demProfile}:${z}/${x}/${y}`;
  if (zonePreviewMap.has(previewKey)) {
    const blob = zonePreviewMap.get(previewKey);
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=15',
        'X-Tile-Type': 'slope',
        'X-Slope-Quality': 'low',
        'X-DEM-Profile': demProfile,
      },
    });
  }

  let fast30mBlob = null;
  try {
    if (typeof fetchAWSTerrainTile === 'function') {
      fast30mBlob = await fetchAWSTerrainTile(z, x, y);
    }
  } catch { /* ignore */ }

  if (!fast30mBlob) {
    try {
      const demReq = new Request(`/dem-tiles/${z}/${x}/${y}?rv-dem-profile=${demProfile}&rv-purpose=slope-zone`);
      const resp = await handleDemRequest(demReq, z, x, y, 0, demProfile);
      if (resp && resp.status === 200) {
        fast30mBlob = await resp.clone().blob();
      }
    } catch { /* ignore */ }
  }

  if (!fast30mBlob) return null;

  const lowResResult = await buildSlopeBlobFromDem(fast30mBlob, z, x, y, demCache, resFactor, demProfile, null, zoneRing);
  if (!lowResResult || !lowResResult.blob) return null;

  zonePreviewMap.set(previewKey, lowResResult.blob);

  return new Response(lowResResult.blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=15',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': 'low',
      'X-DEM-Profile': demProfile,
    },
  });
}

function buildAndCacheHdSlopeTile(z, x, y, resFactor, demProfile, zoneHash, options = {}) {
  const key = `${demProfile}:${z}/${x}/${y}?${zoneHash}`;
  if (backgroundHdSlopeInflight.has(key)) {
    return backgroundHdSlopeInflight.get(key);
  }

  // Analysis-zone tiles are explicitly requested by the user and must NOT be cancelled
  // by viewport camera movements.
  const generation = zoneHash ? null : slopeCancelGeneration;
  const task = (async () => {
    const t0 = performance.now();
    try {
      if (zoneHash) {
        const { entry: zoneEntry } = resolveAnalysisZoneForTile(zoneHash);
        if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
          logDemPente(`ℹ️ Tuile HD ${z}/${x}/${y} hors zone ${zoneHash} -> transparente`);
          return transparentTileResponse();
        }
      }

      logDemPente(`🏔️ Démarrage calcul HD pour ${z}/${x}/${y} (zone=${zoneHash})...`);
      const purpose = zoneHash ? 'slope-zone' : SLOPE_REQUEST_PURPOSE_VISIBLE;
      let demBlob = await fetchLiDARDemTile(z, x, y, demProfile, purpose, zoneHash);

      if (!demBlob && zoneHash) {
        // Fallback to fast 30m AWS terrain so the tile NEVER returns null and zone reaches 100%
        try {
          if (typeof fetchAWSTerrainTile === 'function') {
            demBlob = await fetchAWSTerrainTile(z, x, y);
          }
        } catch { /* ignore */ }
      }

      if (!demBlob || (generation !== null && isSlopeWorkCancelled(generation))) {
        logDemPente(`⚠️ Calcul HD avorté pour ${z}/${x}/${y} (pas de blob DEM ou annulé)`);
        return null;
      }

      const demCache = await caches.open(CACHE_NAME);
      const slopeCache = await caches.open(SLOPE_CACHE_NAME);
      const { ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);

      const slopeResult = await buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing);
      if (!slopeResult || (generation !== null && isSlopeWorkCancelled(generation))) {
        logDemPente(`⚠️ Horn slope vide pour ${z}/${x}/${y}`);
        return null;
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

      // Invalidate parent downsampled tiles when a canonical z14 tile finishes HD (only outside silent batch)
      if (z === 14 && zoneHash && !options?.silent) {
        invalidateParentDownsampledSlopeTiles(z, x, y, zoneHash);
      }

      const dt = Math.round(performance.now() - t0);
      logDemPente(`✨ Succès HD pour ${z}/${x}/${y} en ${dt}ms`);

      // For analysis-zone pipeline, we do NOT emit per-tile updates to avoid patchy tile-by-tile reloads
      if (!options?.silent && !zoneHash) {
        try {
          const clients = await self.clients.matchAll({ type: 'window' });
          for (const client of clients) {
            client.postMessage({
              type: 'SLOPE_TILE_UPDATED',
              z,
              x,
              y,
              profile: demProfile,
              zone: zoneHash,
            });
          }
        } catch { /* ignore */ }
      }

      scheduleSlopeNeighbourWarm(z, x, y, demProfile, demCache, slopeResult.missingNeighbours, generation);
      return response;
    } catch (err) {
      logDemPente(`❌ Erreur buildAndCacheHdSlopeTile ${z}/${x}/${y}: ${err?.message || err}`);
      return null;
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

  const { entry: zoneEntry, ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash && (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y))) {
    return transparentTileResponse();
  }

  // At far zoom levels (z <= 10), compute the slope directly at level z to avoid massive tile fanout
  if (dz > 3) {
    try {
      let fastBlob = null;
      if (typeof fetchAWSTerrainTile === 'function') {
        fastBlob = await fetchAWSTerrainTile(z, x, y);
      }
      if (!fastBlob) {
        const demReq = new Request(`/dem-tiles/${z}/${x}/${y}?rv-dem-profile=${demProfile}&rv-purpose=slope-zone`);
        const resp = await handleDemRequest(demReq, z, x, y, 0, demProfile);
        if (resp && resp.status === 200) fastBlob = await resp.clone().blob();
      }
      if (fastBlob) {
        const demCache = await caches.open(CACHE_NAME);
        const res = await buildSlopeBlobFromDem(fastBlob, z, x, y, demCache, 1, demProfile, null, zoneRing);
        if (res && res.blob) {
          return new Response(res.blob, {
            status: 200,
            headers: {
              'Content-Type': 'image/png',
              'Cache-Control': 'public, max-age=60',
              'X-Tile-Type': 'slope',
              'X-Slope-Quality': 'low',
              'X-DEM-Profile': demProfile,
            },
          });
        }
      }
    } catch { /* fall back */ }
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
  let allChildrenAreHd = true;
  const childBlobs = new Map();

  await Promise.all(childTilesToFetch.map(async ({ cx, cy }) => {
    try {
      const childParams = new URLSearchParams();
      if (resFactor > 1) childParams.set('res', String(resFactor));
      if (demProfile === 'terrain') childParams.set('rv-dem-profile', 'terrain');
      if (zoneHash) childParams.set('zone', zoneHash);
      const childUrl = `/slope-tiles/14/${cx}/${cy}${childParams.size ? `?${childParams.toString()}` : ''}`;

      let blob = null;
      let isHd = false;
      const previewKey = `${zoneHash}:${demProfile}:14/${cx}/${cy}`;

      if (zonePreviewMap.has(previewKey)) {
        blob = zonePreviewMap.get(previewKey);
      }
      if (!blob) {
        const cached = await slopeCache.match(new Request(childUrl));
        if (cached && cached.status === 200) {
          blob = await cached.clone().blob();
          const q = (cached.headers.get('X-Slope-Quality') || '').toLowerCase();
          if (q === 'hd') isHd = true;
        }
      }
      if (!isHd) allChildrenAreHd = false;
      if (!blob) {
        const lowResp = await buildAndCacheLowSlopeTile(14, cx, cy, resFactor, demProfile, zoneHash);
        if (lowResp && lowResp.status === 200) {
          blob = await lowResp.clone().blob();
        }
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
    } catch {
      allChildrenAreHd = false;
    }
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
      'Cache-Control': allChildrenAreHd ? 'public, max-age=604800' : 'public, max-age=5',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': allChildrenAreHd ? 'hd' : 'low',
      'X-DEM-Profile': demProfile,
    },
  });
}

async function buildOverzoomedSlopeTile(z, x, y, resFactor, demProfile, zoneHash) {
  const S = DEM_TILE_SIZE;
  const dz = z - 14;
  if (dz <= 0) return null;
  const scale = 1 << dz;
  const parentX = Math.floor(x / scale);
  const parentY = Math.floor(y / scale);
  const subX = (x % scale) * (S / scale);
  const subY = (y % scale) * (S / scale);
  const subSize = S / scale;

  const parentResp = await handleSlopeRequest(14, parentX, parentY, String(resFactor), demProfile, zoneHash);
  if (!parentResp || parentResp.status !== 200) {
    return transparentTileResponse();
  }

  const parentBlob = await parentResp.clone().blob();
  const img = await createImageBitmap(parentBlob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = (typeof getSharedOffscreenCtx === 'function')
    ? getSharedOffscreenCtx(S, S)
    : new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, subX, subY, subSize, subSize, 0, 0, S, S);
  img.close();
  const imgData = ctx.getImageData(0, 0, S, S);
  const blob = (typeof buildRawPngSlope === 'function')
    ? await buildRawPngSlope(S, S, imgData.data)
    : await buildRawPng(S, S, imgData.data);

  const q = (parentResp.headers.get('X-Slope-Quality') || '').toLowerCase();
  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': q === 'hd' ? 'public, max-age=604800' : 'public, max-age=5',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': q,
      'X-DEM-Profile': demProfile,
    },
  });
}
