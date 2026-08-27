// ---------------------------------------------------------------------------
// Slope Tile Processing — Zone Multi-Fetch Pipeline & Viewport Prewarm
// ---------------------------------------------------------------------------

let activeZonePipeline = null;

function broadcastZoneProgress(zoneHash, phase, loaded, total) {
  let percent = 0;
  if (total > 0) {
    if (phase === 'low') {
      percent = Math.max(1, Math.min(50, Math.round((loaded / total) * 50)));
    } else if (phase === 'hd') {
      percent = Math.max(50, Math.min(99, 50 + Math.round((loaded / total) * 49)));
    } else if (phase === 'done') {
      percent = 100;
    }
  }
  try {
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'ZONE_SLOPE_PROGRESS',
          zone: zoneHash,
          phase,
          loaded,
          total,
          percent,
        });
      });
    }).catch(() => {});
  } catch { /* ignore */ }
}

function extractCanonicalZ14Tiles(tiles, zoneEntry) {
  const rawValidTiles = (tiles || []).filter(
    (t) => t && Number.isFinite(t.z) && Number.isFinite(t.x) && Number.isFinite(t.y) && t.z >= 0 && t.x >= 0 && t.y >= 0,
  );

  const seenZ14 = new Set();
  const canonicalZ14Tiles = [];

  for (const t of rawValidTiles) {
    if (t.z === 14) {
      const key = `${t.x}/${t.y}`;
      if (!seenZ14.has(key)) {
        seenZ14.add(key);
        if (!zoneEntry || tileIntersectsAnalysisZone(zoneEntry, 14, t.x, t.y)) {
          canonicalZ14Tiles.push({ z: 14, x: t.x, y: t.y });
        }
      }
    } else if (t.z < 14) {
      const scale = 1 << (14 - t.z);
      for (let dx = 0; dx < scale; dx++) {
        for (let dy = 0; dy < scale; dy++) {
          const cx = t.x * scale + dx;
          const cy = t.y * scale + dy;
          const key = `${cx}/${cy}`;
          if (!seenZ14.has(key)) {
            seenZ14.add(key);
            if (!zoneEntry || tileIntersectsAnalysisZone(zoneEntry, 14, cx, cy)) {
              canonicalZ14Tiles.push({ z: 14, x: cx, y: cy });
            }
          }
        }
      }
    } else {
      // t.z > 14
      const scale = 1 << (t.z - 14);
      const cx = Math.floor(t.x / scale);
      const cy = Math.floor(t.y / scale);
      const key = `${cx}/${cy}`;
      if (!seenZ14.has(key)) {
        seenZ14.add(key);
        if (!zoneEntry || tileIntersectsAnalysisZone(zoneEntry, 14, cx, cy)) {
          canonicalZ14Tiles.push({ z: 14, x: cx, y: cy });
        }
      }
    }
  }

  return canonicalZ14Tiles;
}

async function startZoneSlopeMultiFetch(tiles, profile, zoneHash) {
  if (!Array.isArray(tiles) || tiles.length === 0) return;
  const demProfile = profile === 'terrain' ? 'terrain' : 'default';
  const zone = (typeof zoneHash === 'string' && zoneHash) ? zoneHash : '';

  if (
    activeZonePipeline &&
    activeZonePipeline.zone === zone &&
    activeZonePipeline.demProfile === demProfile &&
    !activeZonePipeline.cancelled
  ) {
    return;
  }

  if (activeZonePipeline) {
    activeZonePipeline.cancelled = true;
  }
  const currentPipeline = { cancelled: false, zone, demProfile };
  activeZonePipeline = currentPipeline;

  const { entry: zoneEntry } = resolveAnalysisZoneForTile(zone);
  const validTiles = extractCanonicalZ14Tiles(tiles, zoneEntry);
  const total = validTiles.length;
  if (total === 0) return;

  // Check if all zone tiles are ALREADY cached in HD
  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  let allCachedHd = true;
  for (const t of validTiles) {
    const params = new URLSearchParams();
    if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
    if (zone) params.set('zone', zone);
    const keyUrl = `/slope-tiles/${t.z}/${t.x}/${t.y}${params.size ? `?${params.toString()}` : ''}`;
    const cached = await slopeCache.match(new Request(keyUrl));
    if (!cached || (cached.headers.get('X-Slope-Quality') || '').toLowerCase() !== 'hd') {
      allCachedHd = false;
      break;
    }
  }

  if (allCachedHd) {
    logDemPente(`✨ Zone ${zone} déjà 100% HD en cache (${total} tuiles) -> prêt immédiat`);
    zoneStateMap.set(zone, { phase: 'done', demProfile });
    broadcastZoneProgress(zone, 'done', total, total);
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.postMessage({
          type: 'SLOPE_ZONE_HD_READY',
          zone,
          profile: demProfile,
        });
      }
    } catch { /* ignore */ }
    return;
  }

  zoneStateMap.set(zone, { phase: 'low', demProfile });
  logDemPente(`🚀 Lancement Multi-Fetch Zone: hash=${zone} | profile=${demProfile} | total=${total} tuiles z14`);
  broadcastZoneProgress(zone, 'low', 0, total);

  const runConcurrent = async (items, concurrency, fn) => {
    let index = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
      while (index < items.length) {
        if (currentPipeline.cancelled) return;
        const i = index++;
        await fn(items[i], i);
      }
    });
    await Promise.all(workers);
  };

  // Phase 1: Fast 30m preview pass across all zone tiles (concurrency = 8, 100% uniform 30m)
  let lowDone = 0;
  await runConcurrent(validTiles, 8, async (t) => {
    if (currentPipeline.cancelled) return;
    try {
      await buildAndCacheLowSlopeTile(t.z, t.x, t.y, 1, demProfile, zone);
    } catch { /* best-effort */ }
    lowDone++;
    if (!currentPipeline.cancelled) {
      broadcastZoneProgress(zone, 'low', lowDone, total);
    }
  });

  if (currentPipeline.cancelled) return;

  // Signal completion of Phase 1 to frontend so Mapbox paints the uniform 30m preview across all tiles
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({
        type: 'SLOPE_ZONE_PHASE1_READY',
        zone,
        profile: demProfile,
      });
    }
  } catch { /* ignore */ }

  // Transition to Phase 2
  zoneStateMap.set(zone, { phase: 'hd', demProfile });
  broadcastZoneProgress(zone, 'hd', 0, total);

  // Phase 2: True HD LiDAR pass across all zone tiles in parallel (concurrency = 8, silent)
  let hdDone = 0;
  await runConcurrent(validTiles, 8, async (t) => {
    if (currentPipeline.cancelled) return;
    try {
      await buildAndCacheHdSlopeTile(t.z, t.x, t.y, 1, demProfile, zone, { silent: true });
    } catch { /* best-effort */ }
    hdDone++;
    if (!currentPipeline.cancelled) {
      broadcastZoneProgress(zone, 'hd', hdDone, total);
    }
  });

  if (currentPipeline.cancelled) return;

  // Phase 2 is complete for 100% of zone tiles!
  zoneStateMap.set(zone, { phase: 'done', demProfile });
  zonePreviewMap.clear();
  await invalidateParentDownsampledSlopeTiles(14, 0, 0, zone);
  broadcastZoneProgress(zone, 'done', total, total);

  logDemPente(`✨ Zone ${zone} 100% HD terminée (${total} tuiles) -> Bascule atomique`);
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({
        type: 'SLOPE_ZONE_HD_READY',
        zone,
        profile: demProfile,
      });
    }
  } catch { /* ignore */ }
}

function prewarmSlopeTiles(tiles, profile, zoneHash) {
  if (!Array.isArray(tiles) || tiles.length === 0) return;
  if (zoneHash) {
    startZoneSlopeMultiFetch(tiles, profile, zoneHash);
    return;
  }
  const demProfile = profile === 'terrain' ? 'terrain' : 'default';
  const batch = tiles.slice(0, 32);
  let index = 0;
  const concurrency = 6;
  const workers = new Array(Math.min(concurrency, batch.length)).fill(0).map(async () => {
    while (index < batch.length) {
      if (isSlopeWorkCancelled(slopeCancelGeneration)) return;
      const t = batch[index++];
      if (!t || !Number.isFinite(t.z) || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
      try {
        await handleSlopeRequest(t.z, t.x, t.y, '', demProfile, '');
      } catch { /* best-effort */ }
    }
  });
  Promise.all(workers).catch(() => {});
}
