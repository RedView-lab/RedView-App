// ---------------------------------------------------------------------------
// finalize() + background IGN-upgrade scheduler.
//
// finalize() — wraps the chosen elevation blob into a Response, writes it
// to the positive cache, and (if any IGN sub-tiles were still in flight at
// the soft deadline) kicks off a background re-cache to the higher-quality
// IGN composite. Next time Mapbox re-requests the tile, it gets the better
// blob with no user-visible churn.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

async function finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource, upgradePending, inLiDARRegion, upgradeSourceHint, forceShortCache = false, healthStatus = 'ok', demProfile = 'default') {
  // Short cache (15 s) for AWS/overzoom fallback tiles inside any LiDAR
  // region (France or Switzerland) at z≥13. These are transient stand-ins
  // while the exact tile finishes building; longer caching masks the upgrade.
  const shortCache = forceShortCache || (inLiDARRegion
    && z >= 13
    && (demSource.startsWith('aws-terrarium')
      || demSource.startsWith('aws-emergency')
      || demSource.startsWith('overzoom')));
  const response = buildDemResponse(pngBlob, demSource, shortCache, healthStatus);
  cache.put(cacheKey, response.clone());
  if (DEBUG) {
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[sw-dem] ${demSource} ${z}/${x}/${y} ${dt}ms`);
  }
  // Fire-and-forget: if IGN sub-tiles were still in flight at the soft
  // deadline, let them finish in the background and replace the cached blob
  // with a full-quality IGN build. Next time Mapbox requests this tile
  // (natural tile-cache cycling while panning/zooming) it gets best quality.
  if (upgradePending && upgradePending.length) {
    scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint || demSource, demProfile);
  }
  return response;
}

function notifyDemTileCacheUpdated(z, x, y, source) {
  self.clients.matchAll({ type: 'window' })
    .then((clients) => {
      clients.forEach((client) => client.postMessage({
        type: 'DEM_TILE_CACHE_UPDATED',
        z,
        x,
        y,
        source,
      }));
    })
    .catch(() => {
      /* best-effort notification */
    });
}

// Coalesce concurrent upgrade jobs for the same tile.
const pendingUpgrades = new Set();

async function materializeUpgradeResult(result, z, x, y, compositeSource) {
  if (!result?.elevations) return null;
  if (result.blob) {
    return { blob: result.blob, source: result.source || compositeSource };
  }

  await acquireComposite();
  try {
    return {
      blob: await compositeIGNMapbox(result.elevations, result.coverage, z, x, y),
      source: compositeSource,
    };
  } finally {
    releaseComposite();
  }
}

function scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, fetches, preferredSource, demProfile = 'default') {
  const key = `${demProfile}:${z}/${x}/${y}`;
  if (pendingUpgrades.has(key)) return;
  pendingUpgrades.add(key);

  (async () => {
    try {
      await Promise.allSettled(fetches);
      // Skip if a concurrent request already upgraded this tile.
      const existing = await cache.match(cacheKey);
      if (existing) {
        const src = existing.headers.get('X-DEM-Source') || '';
        if (src.endsWith('+upgrade') || src === 'ign' || src.startsWith('ign-fallback-z') || src.startsWith('ign-highres')) {
          // Already full-quality — nothing to gain.
          return;
        }
      }
      // All sub-tiles are now in the IGN memory cache (either as data or as
      // cached-null with TTL). Rebuild — second pass is near-free.
      const tileClass = tileOverlapsOverseasFrance(z, x, y)
        ? 'inside'
        : classifyDemTile(z, x, y);
      if (tileClass === 'outside') return;
      const preferHighres = typeof preferredSource === 'string'
        && preferredSource.startsWith('ign-highres');
      const terrainRebuilder = () => buildIGNTerrainTile(z, x, y, { purpose: 'slope-warm' })
        .then((result) => materializeUpgradeResult(result, z, x, y, 'ign-rgealti-wms-composite'));
      const highresRebuilder = () => buildIGNFallbackTile(z, x, y)
        .then((result) => materializeUpgradeResult(result, z, x, y, 'ign-highres-composite'));
      const mnsRebuilder = () => buildIGNTile(z, x, y, tileClass)
        .then((result) => materializeUpgradeResult(result, z, x, y, 'ign-composite'));
      const rebuilders = demProfile === 'terrain'
        ? [terrainRebuilder, highresRebuilder]
        : preferHighres
        ? [
            highresRebuilder,
            mnsRebuilder,
          ]
        : [
            mnsRebuilder,
            highresRebuilder,
          ];

      let upgraded = null;
      for (const rebuild of rebuilders) {
        upgraded = await rebuild();
        if (upgraded?.blob) break;
      }
      if (!upgraded?.blob) return;

      await cache.put(cacheKey, buildDemResponse(upgraded.blob, upgraded.source + '+upgrade'));
      notifyDemTileCacheUpdated(z, x, y, upgraded.source);
      if (DEBUG) console.log(`[sw-dem][upgrade] ${z}/${x}/${y} re-cached at ${upgraded.source}`);
    } catch (e) {
      if (DEBUG) console.warn(`[sw-dem][upgrade] ${z}/${x}/${y} failed`, e);
    } finally {
      pendingUpgrades.delete(key);
    }
  })();
}
