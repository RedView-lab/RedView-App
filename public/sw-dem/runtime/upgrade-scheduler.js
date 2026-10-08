// ---------------------------------------------------------------------------
// finalize() + ordonnanceur des mises à niveau IGN en arrière-plan.
//
// finalize() — enveloppe le blob d'altitude retenu dans une Response, l'écrit
// dans le cache positif et (si des sous-tuiles IGN étaient encore en cours à
// l'échéance souple) lance en arrière-plan une remise en cache vers la
// composition IGN de meilleure qualité. La prochaine fois que Mapbox redemande
// la tuile, il reçoit le meilleur blob sans remous visible pour l'utilisateur.
//
// Extrait de sw-dem.js (3 mai).
// ---------------------------------------------------------------------------

async function finalize(cache, cacheKey, t0, z, x, y, pngBlob, demSource, upgradePending, inLiDARRegion, upgradeSourceHint, forceShortCache = false, healthStatus = 'ok', demProfile = 'default') {
  // Cache court (15 s) pour les tuiles de repli AWS / overzoom dans une région
  // LiDAR (France ou Suisse) à z≥13. Ce sont des remplaçants passagers pendant
  // que la tuile exacte finit de se construire ; un cache plus long masquerait
  // la mise à niveau.
  const shortCache = forceShortCache || (inLiDARRegion
    && z >= 13
    && (demSource.startsWith('aws-terrarium')
      || demSource.startsWith('aws-emergency')
      || demSource.startsWith('overzoom')));
  const response = buildDemResponse(pngBlob, demSource, shortCache, healthStatus);
  cache.put(cacheKey, response.clone());

  // Promeut la tuile fraîchement construite dans le niveau chaud en mémoire,
  // pour que la requête suivante — en général quelques centaines de ms plus
  // tard, quand Mapbox repeint la même tuile sous un autre angle de caméra, ou
  // quand les handlers de pente / d'altitude se déploient sur les 4 DEM voisins —
  // réponde en < 1 ms au lieu de payer un nouvel aller-retour CacheStorage. Les
  // tuiles à cache court sont volontairement sautées (ce sont des remplaçants
  // jetables en attente de la mise à niveau IGN, et on VEUT que la requête
  // suivante passe par CacheStorage pour que son contrôle de TTL les invalide à
  // temps).
  if (!shortCache) {
    try {
      demHotPut(
        cacheKey.url,
        pngBlob,
        Array.from(response.headers.entries()),
      );
    } catch { /* ignore */ }
    // Les tuiles de pente / d'altitude provisoires auxquelles manquait cette tuile DEM peuvent maintenant être reconstruites.
    if (typeof notifyDerivedDemTileReady === 'function') notifyDerivedDemTileReady(z, x, y, demProfile);
  }
  if (DEBUG) {
    const dt = (performance.now() - t0).toFixed(0);
    console.log(`[sw-dem] ${demSource} ${z}/${x}/${y} ${dt}ms`);
  }
  // Lancé sans attendre : si des sous-tuiles IGN étaient encore en cours à
  // l'échéance souple, on les laisse finir en arrière-plan et on remplace le
  // blob en cache par une construction IGN de pleine qualité. La prochaine fois
  // que Mapbox demande cette tuile (rotation naturelle de son cache pendant les
  // déplacements / zooms), il obtient la meilleure qualité.
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
      /* notification au mieux */
    });
}

// Fusionne les tâches de mise à niveau simultanées d'une même tuile.
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
      // On saute si une requête concurrente a déjà mis à niveau cette tuile.
      const existing = await cache.match(cacheKey);
      if (existing) {
        const src = existing.headers.get('X-DEM-Source') || '';
        if (src.endsWith('+upgrade') || src === 'ign' || src.startsWith('ign-fallback-z') || src.startsWith('ign-highres')) {
          // Déjà en pleine qualité — rien à gagner.
          return;
        }
      }
      // Toutes les sous-tuiles sont maintenant dans le cache mémoire IGN (en
      // donnée ou en nul en cache avec TTL). On reconstruit — la seconde passe
      // ne coûte presque rien.
      const tileClass = tileOverlapsOverseasFrance(z, x, y)
        ? 'inside'
        : classifyDemTile(z, x, y);
      if (tileClass === 'outside') return;
      // Les tuiles intérieures gardent le datum IGN brut, cohérent partout (pas
      // de biais Mapbox par tuile), pour que les tuiles mises à niveau en
      // arrière-plan restent alignées en LOD avec leurs voisines — même règle
      // anti-« mur » que le chemin en direct.
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
      // Une surface MNS de corrélation de l'ancien chemin (WMS LiDAR HD toujours
      // en échec) n'est pas une mise à niveau : on s'arrête là plutôt que de
      // l'enregistrer — ou de laisser le reconstructeur HIGHRES sol nu qui suit —
      // comme réponse définitive de la tuile.
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
  // Rafraîchit le niveau chaud pour que les requêtes suivantes voient tout de
  // suite le blob mis à niveau sans passer par CacheStorage. Sans cela, l'ancien
  // blob (composition / aws / overzoom) resterait chaud jusqu'à son éviction par
  // pression du LRU, retardant en silence l'effet visible de la mise à niveau.
  try {
    demHotPut(cacheKey.url, upgraded.blob, Array.from(response.headers.entries()));
  } catch { /* ignore */ }
  notifyDemTileCacheUpdated(z, x, y, upgraded.source, demProfile);
  if (typeof notifyDerivedDemTileReady === 'function') notifyDerivedDemTileReady(z, x, y, demProfile);
}

// ── Récupération de la surface (MNS) ──────────────────────────────────
// computeDemRequest() a servi un remplaçant provisoire (overzoom du parent ou
// sol nu, brièvement en cache) parce que la construction du MNS à 0,40 m a
// échoué passagèrement. On ne réessaie que la construction MNS — le
// reconstructeur HIGHRES de scheduleBackgroundUpgrade est du sol nu et rendrait
// définitive l'absence des bâtiments. La première tentative couvre un abandon
// CANCEL_STALE_DEM (rien en cache négatif) ; la seconde attend la fin de l'entrée
// nulle passagère qu'un délai WMS dépassé laisse pour IGN_NULL_TTL_TRANSIENT.
// Usage en arrière-plan : priorité de fetch basse, et la concurrence réduite de
// l'arrière-plan l'empêche de concurrencer la vue visible.
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
        // Une entrée de longue durée signifie qu'une construction fraîche de
        // premier plan a déjà produit la vraie tuile ; les remplaçants portent
        // toujours x-cache-ttl-ms.
        const existing = await cache.match(cacheKey);
        if (existing && !existing.headers.get('x-cache-ttl-ms')) return;

        const result = await buildIGNTile(z, x, y, tileClass, PURPOSE_DEM_PREFETCH);
        if (result?.allPermanent404) return;
        // Seule la réponse du WMS récupère la surface ; le repli MNS de
        // corrélation de l'ancien chemin n'est accepté qu'à la dernière tentative
        // (toujours mieux qu'un remplaçant AWS à 30 m).
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
