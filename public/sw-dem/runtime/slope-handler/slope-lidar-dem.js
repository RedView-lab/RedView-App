// ---------------------------------------------------------------------------
// Slope Tile Processing — LiDAR DEM Provider Dispatcher (FR, CH, NO, ES, AWS)
// ---------------------------------------------------------------------------

const zoneMnsUnavailable = new Set();

async function encodeElevationsOrComposite(res, z, x, y, options = {}) {
  if (!res || !res.elevations) return null;
  if (res.blob) return res.blob;
  if (typeof encodeTerrainRGBPng === 'function') {
    return await encodeTerrainRGBPng(res.elevations);
  }
  if (typeof acquireComposite === 'function' && typeof compositeIGNMapbox === 'function') {
    await acquireComposite();
    try {
      return await compositeIGNMapbox(res.elevations, res.coverage, z, x, y, options);
    } finally {
      if (typeof releaseComposite === 'function') releaseComposite();
    }
  }
  return null;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (DEBUG_SLOPE) console.warn(`[slope-lidar] Timeout ${timeoutMs}ms on ${label}`);
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function tryFranceTerrain(z, x, y, purpose) {
  if (typeof buildIGNTerrainTile !== 'function') return null;
  try {
    logDemPente(`🇫🇷 Tentative IGN RGE ALTI 1m WMS pour ${z}/${x}/${y}...`);
    const reqPromise = (async () => {
      const res = await buildIGNTerrainTile(z, x, y, { purpose: purpose || 'slope-zone' });
      return await encodeElevationsOrComposite(res, z, x, y);
    })();
    const blob = await withTimeout(reqPromise, 5000, `IGN RGE ALTI ${z}/${x}/${y}`);
    if (blob) {
      logDemPente(`🇫🇷 ✅ Succès IGN RGE ALTI 1m WMS pour ${z}/${x}/${y}`);
      return blob;
    }
  } catch (err) {
    logDemPente(`🇫🇷 ❌ Erreur IGN RGE ALTI WMS pour ${z}/${x}/${y}: ${err?.message || err}`);
  }
  return null;
}

async function tryFranceMns(z, x, y, zoneHash) {
  if (typeof buildIGNTile !== 'function') return null;
  if (zoneHash && zoneMnsUnavailable.has(zoneHash)) return null;
  if (typeof mnsAreaNegGet === 'function' && mnsAreaNegGet(z, x, y)) return null;

  try {
    if (typeof ensureFrancePoly === 'function') await ensureFrancePoly();
    let franceClass = 'inside';
    if (typeof classifyDemTile === 'function') franceClass = classifyDemTile(z, x, y);
    logDemPente(`🇫🇷 Tentative IGN MNS LiDAR HD pour ${z}/${x}/${y}...`);
    const reqPromise = (async () => {
      const res = await buildIGNTile(z, x, y, franceClass);
      return await encodeElevationsOrComposite(res, z, x, y, { skipDatumBias: franceClass === 'inside' });
    })();
    const blob = await withTimeout(reqPromise, 3500, `IGN MNS ${z}/${x}/${y}`);
    if (blob) {
      logDemPente(`🇫🇷 ✅ Succès IGN MNS LiDAR pour ${z}/${x}/${y}`);
      return blob;
    }
    // Fast skip for remaining zone tiles if MNS is unavailable in this area
    if (zoneHash) zoneMnsUnavailable.add(zoneHash);
  } catch (err) {
    if (zoneHash) zoneMnsUnavailable.add(zoneHash);
    logDemPente(`🇫🇷 ❌ Erreur IGN MNS pour ${z}/${x}/${y}: ${err?.message || err}`);
  }
  return null;
}

async function trySwiss(z, x, y) {
  if (typeof buildSwissTile !== 'function') return null;
  try {
    logDemPente(`🇨🇭 Tentative SwissALTI3D pour ${z}/${x}/${y}...`);
    const res = await buildSwissTile(z, x, y);
    const blob = await encodeElevationsOrComposite(res, z, x, y, { skipDatumBias: true });
    if (blob) {
      logDemPente(`🇨🇭 ✅ Succès SwissALTI3D pour ${z}/${x}/${y}`);
      return blob;
    }
  } catch (err) {
    logDemPente(`🇨🇭 ❌ Erreur Swiss pour ${z}/${x}/${y}: ${err?.message || err}`);
  }
  return null;
}

async function tryNorway(z, x, y) {
  if (typeof buildNorwayTile !== 'function') return null;
  try {
    logDemPente(`🇳🇴 Tentative Norway DTM pour ${z}/${x}/${y}...`);
    const res = await buildNorwayTile(z, x, y);
    const blob = await encodeElevationsOrComposite(res, z, x, y, { skipDatumBias: true });
    if (blob) {
      logDemPente(`🇳🇴 ✅ Succès Norway DTM pour ${z}/${x}/${y}`);
      return blob;
    }
  } catch (err) {
    logDemPente(`🇳🇴 ❌ Erreur Norway pour ${z}/${x}/${y}: ${err?.message || err}`);
  }
  return null;
}

async function trySpain(z, x, y) {
  if (typeof buildSpainTile !== 'function') return null;
  try {
    logDemPente(`🇪🇸 Tentative Spain MDT pour ${z}/${x}/${y}...`);
    const res = await buildSpainTile(z, x, y);
    const blob = await encodeElevationsOrComposite(res, z, x, y, { skipDatumBias: true });
    if (blob) {
      logDemPente(`🇪🇸 ✅ Succès Spain MDT pour ${z}/${x}/${y}`);
      return blob;
    }
  } catch (err) {
    logDemPente(`🇪🇸 ❌ Erreur Spain pour ${z}/${x}/${y}: ${err?.message || err}`);
  }
  return null;
}

async function fetchLiDARDemTile(z, x, y, demProfile, purpose = 'slope-zone', zoneHash = '') {
  const inFR = typeof tileOverlapsFrance === 'function' && (tileOverlapsFrance(z, x, y) || (typeof tileOverlapsOverseasFrance === 'function' && tileOverlapsOverseasFrance(z, x, y)));
  const inCH = typeof tileOverlapsSwitzerland === 'function' && tileOverlapsSwitzerland(z, x, y);
  const inNO = typeof tileOverlapsNorway === 'function' && tileOverlapsNorway(z, x, y);
  const inES = typeof tileOverlapsSpain === 'function' && tileOverlapsSpain(z, x, y);

  logDemPente(`🔍 fetchLiDARDemTile ${z}/${x}/${y} | FR=${inFR} CH=${inCH} NO=${inNO} ES=${inES} profile=${demProfile} purpose=${purpose}`);

  if (inFR) {
    if (demProfile === 'terrain') {
      const terrainBlob = await tryFranceTerrain(z, x, y, purpose);
      if (terrainBlob) return terrainBlob;
      // When in bare-earth terrain mode, NEVER fallback to surface MNS (to avoid canopy noise).
      // Fallback straight to AWS/Mapbox 30m bare-earth terrain below.
    } else {
      const mnsBlob = await tryFranceMns(z, x, y, zoneHash);
      if (mnsBlob) return mnsBlob;
      const terrainBlob = await tryFranceTerrain(z, x, y, purpose);
      if (terrainBlob) return terrainBlob;
    }
  }

  if (inCH) {
    const swissBlob = await trySwiss(z, x, y);
    if (swissBlob) return swissBlob;
  }

  if (inNO) {
    const norwayBlob = await tryNorway(z, x, y);
    if (norwayBlob) return norwayBlob;
  }

  if (inES) {
    const spainBlob = await trySpain(z, x, y);
    if (spainBlob) return spainBlob;
  }

  // Universal Fallback (Mapbox / AWS bare-earth DEM)
  try {
    logDemPente(`🌐 Fallback handleDemRequest pour ${z}/${x}/${y}...`);
    const demReq = new Request(`/dem-tiles/${z}/${x}/${y}?rv-dem-profile=${demProfile}&rv-purpose=${purpose}`);
    const resp = await handleDemRequest(demReq, z, x, y, 0, demProfile);
    if (resp && resp.status === 200) {
      logDemPente(`🌐 ✅ Succès handleDemRequest pour ${z}/${x}/${y}`);
      return await resp.clone().blob();
    }
  } catch (err) {
    logDemPente(`🌐 ❌ Erreur fallback handleDemRequest pour ${z}/${x}/${y}: ${err?.message || err}`);
  }

  // Final fallback to fast 30m AWS terrain blob
  try {
    if (typeof fetchAWSTerrainTile === 'function') {
      const awsBlob = await fetchAWSTerrainTile(z, x, y);
      if (awsBlob) return awsBlob;
    }
  } catch { /* ignore */ }

  logDemPente(`⚠️ Aucun DEM HD disponible pour ${z}/${x}/${y}`);
  return null;
}
