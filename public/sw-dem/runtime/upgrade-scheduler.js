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

  // Promote freshly built tile into the in-memory hot tier so the next
  // request — typically a few hundred ms later, when Mapbox re-paints the
  // same tile under a different camera angle, or when slope/altitude
  // handlers fan out to the 4 neighbour DEMs — returns in <1 ms instead
  // of paying for another CacheStorage round-trip. Short-cache tiles are
  // intentionally skipped (they're throwaway placeholders waiting for
  // the IGN upgrade to land, and we WANT the next request to hit
  // CacheStorage so its TTL check can invalidate them on time).
  if (!shortCache) {
    try {
      demHotPut(
        cacheKey.url,
        pngBlob,
        Array.from(response.headers.entries()),
      );
    } catch { /* ignore */ }
    // Provisional slope tiles that lacked this DEM tile can now be rebuilt.
    if (typeof notifySlopeDemTileReady === 'function') notifySlopeDemTileReady(z, x, y, demProfile);
  }
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

function notifyDemTileCacheUpdated(z, x, y, source, profile) {
  self.clients.matchAll({ type: 'window' })
    .then((clients) => {
      clients.forEach((client) => client.postMessage({
        type: 'DEM_TILE_CACHE_UPDATED',
        z,
        x,
        y,
        source,
        profile,
      }));
    })
    .catch(() => {
      /* best-effort notification */
    });
}

// Coalesce concurrent upgrade jobs for the same tile.
const pendingUpgrades = new Set();

async function materializeUpgradeResult(result, z, x, y, compositeSource, skipDatumBias = false) {
  if (result?.cancelled) return { cancelled: true };
  if (!result?.elevations) return null;
  if (result.blob) {
    return { blob: result.blob, source: result.source || compositeSource };
  }

  await acquireComposite();
  try {
    return {
      blob: await compositeIGNMapbox(result.elevations, result.coverage, z, x, y, { skipDatumBias }),
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
      // Interior tiles keep the raw, globally-consistent IGN datum (no
      // per-tile Mapbox bias) so background-upgraded tiles stay LOD-aligned
      // with their neighbours — same anti-"wall" rule as the live path.
      const skipDatumBias = tileClass === 'inside';
      const preferHighres = typeof preferredSource === 'string'
        && preferredSource.startsWith('ign-highres');
      const tileBounds = mercatorTileBounds(z, x, y);
      const tileCenterLat = (tileBounds.north + tileBounds.south) / 2;
      const terrainWmsEligible = demProfile === 'terrain' && shouldUseIGNTerrainWms(z, tileCenterLat);
      const terrainRebuilder = () => buildIGNTerrainTile(z, x, y, { purpose: 'slope-warm' })
        .then((result) => materializeUpgradeResult(result, z, x, y, 'ign-rgealti-wms-composite', skipDatumBias));
      const highresRebuilder = () => buildIGNFallbackTile(z, x, y)
        .then((result) => materializeUpgradeResult(result, z, x, y, 'ign-highres-composite', skipDatumBias));
      // A legacy correlation-MNS surface (LiDAR HD WMS still failing) is not
      // an upgrade: stop there rather than commit it — or the bare-earth
      // HIGHRES rebuilder after it — as the tile's permanent answer.
      const mnsRebuilder = () => buildIGNTile(z, x, y, tileClass)
        .then((result) => (isProvisionalMnsBuild(result, z, x, y)
          ? { provisional: true }
          : materializeUpgradeResult(result, z, x, y, 'ign-composite', skipDatumBias)));
      const rebuilders = demProfile === 'terrain'
        ? (terrainWmsEligible ? [terrainRebuilder, highresRebuilder] : [highresRebuilder])
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
        if (upgraded?.cancelled || upgraded?.provisional) return;
        if (upgraded?.blob) break;
      }
      if (!upgraded?.blob) return;

      await commitUpgradedDemTile(cache, cacheKey, z, x, y, upgraded, demProfile);
      if (DEBUG) console.log(`[sw-dem][upgrade] ${z}/${x}/${y} re-cached at ${upgraded.source}`);
    } catch (e) {
      if (DEBUG) console.warn(`[sw-dem][upgrade] ${z}/${x}/${y} failed`, e);
    } finally {
      pendingUpgrades.delete(key);
    }
  })();
}

async function commitUpgradedDemTile(cache, cacheKey, z, x, y, upgraded, demProfile) {
  const response = buildDemResponse(upgraded.blob, upgraded.source + '+upgrade');
  await cache.put(cacheKey, response.clone());
  // Refresh the hot tier so subsequent requests see the upgraded blob
  // immediately without going through CacheStorage. Without this, the
  // older (composite/aws/overzoom) blob would stay hot until evicted
  // by LRU pressure, silently delaying the upgrade's visual effect.
  try {
    demHotPut(cacheKey.url, upgraded.blob, Array.from(response.headers.entries()));
  } catch { /* ignore */ }
  notifyDemTileCacheUpdated(z, x, y, upgraded.source, demProfile);
  if (typeof notifySlopeDemTileReady === 'function') notifySlopeDemTileReady(z, x, y, demProfile);
}

// ── Surface (MNS) recovery ────────────────────────────────────────────
// computeDemRequest() served a provisional stand-in (parent overzoom or bare
// earth, short-cached) because the 0.40 m MNS build failed transiently. Retry
// the MNS build only — scheduleBackgroundUpgrade's HIGHRES rebuilder is bare
// earth and would make the missing buildings permanent. The first retry
// covers a CANCEL_STALE_DEM abort (nothing negative-cached); the second waits
// out the transient null entry a WMS timeout leaves for IGN_NULL_TTL_TRANSIENT.
// Background purpose: low fetch priority, and the reduced background
// concurrency keeps it from competing with the visible viewport.
const SURFACE_RECOVERY_DELAYS_MS = [1_500, IGN_NULL_TTL_TRANSIENT + 1_000, 40_000];

function scheduleSurfaceMnsRecovery(cache, cacheKey, z, x, y, tileClass, demProfile = 'default') {
  if (tileClass === 'outside') return;
  const key = `surface:${demProfile}:${z}/${x}/${y}`;
  if (pendingUpgrades.has(key)) return;
  pendingUpgrades.add(key);

  (async () => {
    try {
      for (let attempt = 0; attempt < SURFACE_RECOVERY_DELAYS_MS.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, SURFACE_RECOVERY_DELAYS_MS[attempt]));
        // A long-lived entry means a fresh foreground build already produced
        // the real tile; stand-ins always carry x-cache-ttl-ms.
        const existing = await cache.match(cacheKey);
        if (existing && !existing.headers.get('x-cache-ttl-ms')) return;

        const result = await buildIGNTile(z, x, y, tileClass, PURPOSE_DEM_PREFETCH);
        if (result?.allPermanent404) return;
        // Only the WMS answer recovers the surface; the legacy correlation-MNS
        // fallback is accepted on the last attempt only (still better than an
        // AWS 30 m stand-in).
        const lastAttempt = attempt === SURFACE_RECOVERY_DELAYS_MS.length - 1;
        if (result?.cancelled || (!lastAttempt && isProvisionalMnsBuild(result, z, x, y))) continue;
        const upgraded = await materializeUpgradeResult(
          result, z, x, y, 'ign-composite', tileClass === 'inside',
        );
        if (!upgraded?.blob) continue;

        await commitUpgradedDemTile(cache, cacheKey, z, x, y, upgraded, demProfile);
        if (DEBUG) console.log(`[sw-dem][surface-recovery] ${z}/${x}/${y} re-cached at ${upgraded.source}`);
        return;
      }
    } catch (e) {
      if (DEBUG) console.warn(`[sw-dem][surface-recovery] ${z}/${x}/${y} failed`, e);
    } finally {
      pendingUpgrades.delete(key);
    }
  })();
}
