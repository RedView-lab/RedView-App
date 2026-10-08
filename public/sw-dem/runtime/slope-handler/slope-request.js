// ---------------------------------------------------------------------------
// Traitement des tuiles de pente — handler des requêtes HTTP (/slope-tiles/{z}/{x}/{y})
//
// Tuiles alignées sur le terrain (sans zone) : la page demande exactement les
// tuiles de la pyramide DEM du terrain 3D (slope-source.ts), donc la tuile de
// pente z/x/y est Horn sur la tuile DEM z/x/y — celle que montre le maillage du
// terrain —, raccordée à ses quatre voisines et suréchantillonnée 2×. Les
// requêtes ne sont jamais annulées par un geste : le travail est borné par le
// DEM dont le terrain a besoin de toute façon, et une requête annulée répondait
// un remplaçant transparent que Mapbox gardait comme tuile définitive (des
// trous dans l'overlay jusqu'à un rechargement).
// ---------------------------------------------------------------------------

function provisionalSlopeResponse(blob, quality, demProfile) {
  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
      'X-Tile-Type': 'slope',
      'X-Slope-Quality': quality,
      'X-Slope-Seam': 'provisional',
      'X-DEM-Profile': demProfile,
    },
  });
}

// options.sourceDem          'hd' | 'fast-30m' (ancien '' = HD sans contrôle de couverture)
// options.noAncestorFallback interne : pas de repli sur la pente du parent (garde contre la récursion)
async function handleSlopeRequest(z, x, y, resParam, demProfile = 'default', zoneHash = '', options = {}) {
  const resFactor = (() => {
    const n = parseInt(resParam, 10);
    return Number.isFinite(n) && n > 1 ? Math.min(n, 64) : 1;
  })();
  const sourceDem = options?.sourceDem || (demProfile === 'fast-30m' ? 'fast-30m' : '');

  // ── HD demandé hors de toute emprise de DEM haute résolution ─────────
  // L'Italie, l'Allemagne, la Belgique… n'ont que le DEM mondial AWS à 30 m. On
  // sert exactement ce que sert le mode 30 m (entrées de cache partagées), avec
  // des tuiles z>13 suréchantillonnées depuis la pente native z13.
  if (sourceDem === 'hd' && !zoneHash && !(await slopeTileHasHdCoverage(z, x, y))) {
    return handleSlopeRequest(z, x, y, resParam, 'default', '', { ...options, sourceDem: 'fast-30m' });
  }

  const slopeCache = await caches.open(SLOPE_CACHE_NAME);
  const params = new URLSearchParams();
  if (resFactor > 1) params.set('res', String(resFactor));
  if (demProfile === 'terrain') params.set('rv-dem-profile', 'terrain');
  if (sourceDem) params.set('source-dem', sourceDem);
  if (zoneHash) params.set('zone', zoneHash);
  const cacheKeyUrl = `/slope-tiles/${z}/${x}/${y}${params.size ? `?${params.toString()}` : ''}`;
  const hotKey = `${sourceDem ? `${sourceDem}:` : ''}${demProfile}:${cacheKeyUrl}`;

  // ── Hot tier (SLOPE_HOT_CACHE) ──────────────────────────────────────
  const hot = (typeof slopeHotGet === 'function') ? slopeHotGet(hotKey) : null;
  if (hot) {
    return slopeHotResponse(hot);
  }

  const cacheKey = new Request(cacheKeyUrl);
  const cached = await slopeCache.match(cacheKey);
  if (cached) {
    try {
      if (typeof slopeHotPut === 'function') {
        slopeHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries()));
      }
    } catch { /* ignore */ }
    return cached;
  }

  // ── Analysis-zone early rejection ───────────────────────────────────
  const { entry: zoneEntry, ring: zoneRing } = resolveAnalysisZoneForTile(zoneHash);
  if (zoneHash) {
    if (!zoneEntry || !tileIntersectsAnalysisZone(zoneEntry, z, x, y)) {
      return transparentTileResponse();
    }
  }

  // ── In-flight coalescing ────────────────────────────────────────────
  const inflightKey = `${sourceDem ? `${sourceDem}:` : ''}${demProfile}:${z}/${x}/${y}?${resFactor}${zoneHash ? `&z=${zoneHash}` : ''}`;
  const existing = SLOPE_INFLIGHT.get(inflightKey);
  if (existing) {
    try { return (await existing).clone(); }
    catch { /* on continue et on recalcule */ }
  }

  // Les tuiles de zone gardent la résolution native du pipeline z14 et leurs
  // propres messages de rechargement ; les tuiles alignées sur le terrain
  // signalent chaque réponse provisoire.
  const outputScale = zoneHash ? 1 : SLOPE_OUTPUT_SCALE;
  const is30m = sourceDem === 'fast-30m' || sourceDem === '30m' || demProfile === 'fast-30m';
  // Une tuile provisoire est reconstruite quand les tuiles DEM qui lui manquent
  // arrivent (HD), ou par une nouvelle tentative à l'aveugle plafonnée (30 m : les
  // voisines AWS sont récupérées directement, donc un échec y est une panne
  // réseau, pas une tuile encore à venir).
  const reloadWhenReady = (pendingDemTiles) => {
    if (zoneHash) return;
    if (is30m || pendingDemTiles.length === 0) {
      noteSlopeTileStale(hotKey);
      return;
    }
    waitSlopeTileOnDem(hotKey, demProfile, z, pendingDemTiles);
  };

  const work = (async () => {
    // Plafonds de zoom natif (resolveSlopeMaxZoom de slope-source.ts) : le 30 m
    // s'arrête à z13 (AWS z14 est suréchantillonné côté serveur), le HD à z16.
    const maxAllowedZ = is30m ? GLOBAL_SLOPE_NATIVE_MAX_Z : HD_SLOPE_MAX_Z;
    if (z > maxAllowedZ) {
      if (is30m && !zoneHash && z <= HD_SLOPE_MAX_Z) {
        return buildUpsampledGlobalSlopeResponse(z, x, y, resParam, cacheKey, hotKey, slopeCache);
      }
      return transparentTileResponse();
    }

    const demCache = await caches.open(CACHE_NAME);
    const demResponse = await getExistingTerrainDemResponse(z, x, y, demProfile, demCache, sourceDem);
    const ownDemSource = (demResponse?.headers.get('X-DEM-Source') || '').toLowerCase();

    // ── Pas de tuile DEM, ou seulement un overzoom de parent ──────────
    // Le terrain y rend le maillage de son parent : on montre la pente du parent
    // (recadrée + suréchantillonnée) plutôt qu'un trou, et on n'exécute jamais
    // Horn sur un DEM suréchantillonné en Catmull-Rom (ondulations). Provisoire
    // jusqu'au vrai DEM.
    if (!demResponse || demResponse.status !== 200 || ownDemSource.startsWith('overzoom')) {
      if (!zoneHash) {
        // Nouvelle tentative à l'aveugle plafonnée (une 204 peut être passagère)
        // + reconstruction dès qu'une mise à niveau en arrière-plan enregistre la
        // vraie tuile.
        noteSlopeTileStale(hotKey);
        if (!is30m) waitSlopeTileOnDem(hotKey, demProfile, z, [[x, y]]);
      }
      if (!zoneHash && !options.noAncestorFallback) {
        const blob = await buildSlopeFromAncestorDem(
          z, x, y, resParam, demProfile, sourceDem, demCache, DEM_TILE_SIZE * outputScale,
        );
        if (blob) return provisionalSlopeResponse(blob, 'ancestor', demProfile);
      }
      return transparentTileResponse();
    }

    // Les voisines ne sont raccordées que si elles viennent de la même classe de
    // DEM que cette tuile (AWS 30 m contre DEM national haute résolution).
    const ownSourceClass = slopeDemSourceClass(ownDemSource);
    // Un DEM de secours / à TTL court remplace une tuile encore en construction :
    // on sert la pente, mais on ne la fige jamais dans un niveau de cache.
    const ownDemIsFinal = (demResponse.headers.get('X-DEM-Health') || 'ok').toLowerCase() === 'ok'
      && !demResponse.headers.get('x-cache-ttl-ms')
      && !/parent|overzoom|emergency/.test(ownDemSource);

    try {
      const demBlob = await demResponse.blob();
      const slopeResult = await buildSlopeBlobFromDem(
        demBlob, z, x, y, demCache, resFactor, demProfile, null, zoneRing, sourceDem, ownSourceClass, outputScale,
      );
      if (!slopeResult?.blob) {
        reloadWhenReady([]);
        return transparentTileResponse();
      }

      const pendingDemTiles = [...slopeResult.missingNeighbours, ...slopeResult.standInNeighbours];
      if (!ownDemIsFinal) pendingDemTiles.push([x, y]);
      const isSeamComplete = slopeResult.missingNeighbours.length === 0;
      const isPersistable = pendingDemTiles.length === 0;
      const response = new Response(slopeResult.blob, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': isPersistable ? 'public, max-age=604800' : 'no-cache',
          'X-Tile-Type': 'slope',
          'X-Slope-Quality': 'hd',
          'X-Slope-Seam': isSeamComplete ? 'complete' : 'provisional',
          'X-DEM-Profile': demProfile,
        },
      });

      // Seules les tuiles définitives entrent dans CacheStorage et le niveau
      // chaud : une entrée chaude provisoire serait resservie au lieu de la
      // reconstruction.
      if (isPersistable) {
        slopeCache.put(cacheKey, response.clone());
        try {
          if (typeof slopeHotPut === 'function') {
            slopeHotPut(hotKey, slopeResult.blob, Array.from(response.headers.entries()));
          }
        } catch { /* ignore */ }
        if (!zoneHash) noteSlopeTileFinal(hotKey);
      } else {
        reloadWhenReady(pendingDemTiles);
      }
      return response;
    } catch (err) {
      console.error('[slope]', z, x, y, err);
      reloadWhenReady([]);
      return transparentTileResponse();
    }
  })();

  SLOPE_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    if (SLOPE_INFLIGHT.get(inflightKey) === work) {
      SLOPE_INFLIGHT.delete(inflightKey);
    }
  }
}
