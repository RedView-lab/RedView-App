// ---------------------------------------------------------------------------
// Handler des tuiles DEM — pipeline lourd des requêtes /dem-tiles/{z}/{x}/{y}.
//
// Priorité d'aiguillage (de la plus haute à la plus basse) :
//   1. cache positif  (le TTL respecte x-cache-ttl-ms pour les tuiles passagères)
//   2. cache négatif  (TTL borné, avec une seule tentative de sauvetage par overzoom)
//   3. MNS LiDAR suisse via swissSURFACE3D (si la tuile est en Suisse)
//   4. MNT national norvégien via le WCS Kartverket / Geonorge (si la tuile est en Norvège)
//   5. MDT national espagnol à 5 m via le WCS IGN / IDEE (si la tuile est en Espagne)
//   6. pipelines France IGN MNS / RGE ALTI / repli WMTS
//   7. overzoom du parent préservant le LiDAR en FR/CH/NO/ES à z > MAPBOX_DEM_MAXZOOM
//   8. repli mondial AWS Terrarium
//   9. dernier overzoom du parent sur le chemin hors LiDAR / faible zoom
//   10. 204 + cache négatif
//
// Extrait de runtime/dem-handler.js vers runtime/dem-handler/ (15 mai).
// ---------------------------------------------------------------------------

// options.finalOnly  construction pour l'export vidéo (handleVideoDemRequest) :
//                    un remplaçant brièvement en cache ou une entrée négative
//                    courte ne sont pas une réponse, la tuile est reconstruite.
async function computeDemRequest(_request, z, x, y, _depth, demProfile, options = {}) {
  const t0 = performance.now();
  const finalOnly = Boolean(options?.finalOnly);
  const requestPurpose = resolveDemRequestPurposeFromRequest(_request);
  // Renseigné seulement pour les requêtes de tuiles de la carte elle-même : leur
  // travail IGN est abandonné dès que la carte n'attend plus la tuile
  // (DEM_WANTED_TILES), et jamais avant.
  const mapTile = _depth === 0 && requestPurpose == null && isMapDemTileRequest(_request)
    ? { key: `${z}/${x}/${y}`, requestedAt: Date.now() }
    : null;
  const inLiDARRiskRegion = isExpertFallbackRiskTile(z, x, y);
  const cacheKey = buildDemCacheKey(z, x, y, demProfile);
  const hotKey = cacheKey.url;

  // 0. Niveau chaud en mémoire — voir DEM_HOT_CACHE dans runtime/hot-caches.js.
  // Renvoie une Response neuve en < 1 ms et épargne au fil du SW tout un
  // aller-retour CacheStorage (open + match ≈ 5 à 25 ms chacun) dans le cas très
  // courant où l'on réaffiche des tuiles que l'utilisateur vient de dépasser.
  // Un succès n'a jamais besoin du cache négatif ni du classement France, car
  // l'entrée chaude n'est écrite que par `finalize()` après un succès confirmé
  // du pipeline.
  const hot = demHotGet(hotKey);
  if (hot) return demHotResponse(hot);

  // 1+2. Niveaux CacheStorage — ouvre LES DEUX caches et cherche LES DEUX clés en
  // parallèle. Des await successifs ajoutaient jusqu'à ~30 à 50 ms par tuile sur
  // un CacheStorage sur disque ; pour un déplacement de 100 tuiles, cela faisait
  // 3 à 5 s de pure latence d'E/S sur le fil du SW, même quand toutes les
  // lectures échouaient au final (session à froid) ou réussissaient toutes
  // (réaffichage à chaud).
  const [cache, negCache] = await Promise.all([
    caches.open(CACHE_NAME),
    caches.open(NEGATIVE_CACHE_NAME),
  ]);
  const [cached, negCached] = await Promise.all([
    cache.match(cacheKey),
    negCache.match(cacheKey),
  ]);

  // 1. Positive cache
  if (cached) {
    const ttlMs = parseInt(cached.headers.get('x-cache-ttl-ms') || '0', 10);
    if (!ttlMs) {
      // Promotion dans le niveau chaud pour que la requête suivante saute
      // CacheStorage. On fait un clone() car le corps d'une Response ne se lit
      // qu'une fois — on renvoie l'original à l'appelant, le clone va au niveau chaud.
      try { demHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries())); } catch { /* ignore */ }
      return cached;
    }

    const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
    const fresh = cachedAt > 0 && (Date.now() - cachedAt) < ttlMs;
    // Un remplaçant encore dans son TTL continue de servir la carte en direct ;
    // une construction vidéo va jusqu'à la vraie tuile, qui le remplace.
    if (fresh && !finalOnly) return cached;
    if (!fresh) await cache.delete(cacheKey);
  }

  // 2. Negative cache (TTL-bounded)
  if (negCached) {
    const age = parseInt(negCached.headers.get('x-cached-at') || '0', 10);
    const ttl = parseInt(negCached.headers.get('x-neg-ttl') || String(NEGATIVE_TTL_PIPELINE), 10);
    const live = age && (Date.now() - age) < ttl * 1000;
    // Une entrée courte du pipeline est un échec passager : une construction vidéo la réessaie.
    if (live && !(finalOnly && ttl < NEGATIVE_TTL_CONFIRMED)) {
      // On tente une fois l'overzoom, sinon on respecte le cache négatif
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, inLiDARRiskRegion, '', false, 'ok', demProfile);
      return noTileResponse('neg-cache');
    }
    if (!live) negCache.delete(cacheKey);
  }

  // 2b. Fast 30m mode: directly serve AWS Terrarium (global 30m, zero country-specific oversampling)
  if (demProfile === 'fast-30m') {
    try {
      const pngBlob = await fetchAWSTerrainTile(z, x, y);
      if (pngBlob) {
        return finalize(cache, cacheKey, t0, z, x, y, pngBlob, 'aws-fast-30m', null, false, '', false, 'ok', demProfile);
      }
      return noTileResponse('aws-failed');
    } catch {
      return noTileResponse('aws-error');
    }
  }

  const inFrance = tileOverlapsFrance(z, x, y);
  const inOverseasFrance = tileOverlapsOverseasFrance(z, x, y);
  const inSwitzerland = tileOverlapsSwitzerland(z, x, y);
  const inNorway = tileOverlapsNorway(z, x, y);
  const inSpain = tileOverlapsSpain(z, x, y);
  let tileIsInFrance = false; // remonté pour que le gestionnaire d'erreur puisse l'utiliser pour finalize()
  let considerSpain = false;
  try {
    let pngBlob;
    let demSource = 'none';
    let forceShortCache = false;
    let healthStatus = 'ok';

    // 3. Pipeline IGN France — conditionné par la densité de pixels, pas par un
    // zoom codé en dur. shouldUseIGN(z, lat) renvoie true quand le pixel rendu
    // est plus petit que la distance d'échantillonnage native d'environ 30 m de
    // Mapbox : on n'investit dans l'IGN que là où le détail LiDAR est vraiment
    // visible. Tient compte de la latitude : gère la Corse (latitude basse,
    // basculement plus tôt) et Dunkerque (latitude haute, basculement plus tard)
    // avec la même fonction continue au lieu d'un zoom magique.
    let upgradePending = null; // fetchs de sous-tuiles IGN en cours, pour la remise en cache en arrière-plan
    let upgradeSourceHint = '';
    let ignHadSomeData = false; // vrai quand le MNS a renvoyé une couverture partielle ou complète
    let franceHadSomeData = false;
    let franceTransientFailure = false; // IGN expiré / partiellement résolu ; on garde le maillage parent au lieu de mettre en cache un enfant AWS plat
    // La construction de la surface (MNS 0,40 m) a échoué pour une raison
    // passagère — délai WMS dépassé, nouvelles tentatives épuisées, ou abandon
    // par CANCEL_STALE_DEM au zoomstart. Tous les replis suivants sont du sol nu
    // (MNT / RGE ALTI / AWS) : en enregistrer un comme réponse de cette tuile
    // efface les bâtiments et les arbres que montrait la tuile parente — le relief
    // disparaît au fur et à mesure que l'utilisateur zoome.
    let franceSurfaceTransient = false;
    const tileBounds = mercatorTileBounds(z, x, y);
    const tileCenterLat = (tileBounds.north + tileBounds.south) / 2;
    const useFranceTerrainOnly = demProfile === 'terrain';
    const useFranceTerrainWms = useFranceTerrainOnly && shouldUseIGNTerrainWms(z, tileCenterLat);
    const useFranceMNS = !useFranceTerrainOnly && shouldUseIGN(z, tileCenterLat);
    const useFranceHighres = useFranceMNS || shouldUseIGNHighres(z, tileCenterLat);

    // ── Classement par le polygone France résolu EN AMONT.
    // tileOverlapsFrance() est un test de bbox généreux qui couvre AUSSI la
    // majeure partie de la Suisse (FRANCE_BOUNDS vaut [-5.5, 41, 10.0, 51.5]).
    // L'ancienne version de ce dispatcher conditionnait la branche suisse par
    // `!inFrance`, ce qui la désactivait en silence sur ~95 % de la Suisse. Le
    // test de polygone ci-dessous est la réponse qui fait foi à « cette tuile
    // est-elle vraiment en France », et c'est lui qui conditionne désormais les
    // deux branches.
    let franceClass = 'outside';
    let tileCenterInFrancePoly = false;
    if (inFrance && useFranceHighres) {
      if (await ensureFrancePoly()) {
        franceClass = classifyDemTile(z, x, y);
        // classifyDemTile() promeut en 'border' toute tuile z≥12 qui recoupe la
        // BBOX de la France, même quand le polygone ne contient aucun point
        // d'échantillonnage (filet de sécurité voulu pour les tuiles de sommet de
        // moins de 100 m dont l'échantillonnage 6×6 peut rater une frange
        // française près du Mont-Blanc / des Pyrénées). Cette promotion attrape
        // AUSSI tout le plateau suisse, car FRANCE_BOUNDS va à l'est jusqu'à
        // lng=10.0. On teste donc en plus le centre de la tuile contre le
        // polygone, pour savoir si la tuile est *majoritairement* française
        // (→ l'IGN l'emporte) ou si elle effleure seulement la bbox (→ la Suisse
        // l'emporte quand la tuile est en Suisse).
        const centerLng = (tileBounds.west + tileBounds.east) / 2;
        const centerLat = (tileBounds.north + tileBounds.south) / 2;
        tileCenterInFrancePoly = pointInFrance(centerLng, centerLat);
      }
    } else if (inOverseasFrance && useFranceHighres) {
      // Territoires français d'outre-mer (REU/GLP/MTQ/MYT/GUF) — france-border.json
      // ne couvre que la métropole : le test de polygone répondrait toujours
      // « dehors » et sauterait le chemin IGN HD. On traite toute la bbox comme
      // 'inside' (aucune ambiguïté CH/NO/ES — ces bbox ne recoupent aucun autre
      // pipeline national), et buildIGNTile tourne sans découpe par polygone pixel
      // par pixel.
      franceClass = 'inside';
      tileCenterInFrancePoly = true;
    }
    // tileIsInFrance : tout recouvrement avec la France (sert à conditionner
    // l'IGN et aux indicateurs de finalize). Les tuiles de bord passent quand
    // même par l'IGN même si leur centre est en Suisse, car le MNS IGN peut
    // couvrir la bande française.
    tileIsInFrance = franceClass !== 'outside';
    // tilePredominantlyFrench : vrai seulement quand le centre de la tuile est
    // vraiment dans le polygone France (ou que le polygone couvre toute la
    // tuile). Sert à décider qui *l'emporte* entre la Suisse et l'IGN quand les
    // deux pourraient tourner.
    const tilePredominantlyFrench = franceClass === 'inside' || tileCenterInFrancePoly;

    // ── Stricter "tile actually overlaps France polygon" test.
    let tileTrulyTouchesFrance = tileIsInFrance;
    if (tileIsInFrance && franceClass === 'border' && inSwitzerland) {
      const cLng = (tileBounds.west + tileBounds.east) / 2;
      const cLat = (tileBounds.north + tileBounds.south) / 2;
      tileTrulyTouchesFrance =
        tileCenterInFrancePoly ||
        pointInFrance(tileBounds.west, cLat) ||
        pointInFrance(tileBounds.east, cLat) ||
        pointInFrance(cLng, tileBounds.north) ||
        pointInFrance(cLng, tileBounds.south);
    }

    // ── Branche Suisse — s'exécute quand la tuile est sur l'emprise LV95 suisse
    // ET n'est pas majoritairement française. Les tuiles de bord dont le centre
    // est revendiqué par le polygone français vont quand même à l'IGN.
    let swissHadSomeData = false;
    let swissTransientFailure = false; // délai STAC / en-tête dépassé ; NE PAS mettre en cache un Mapbox plat comme réponse
    const considerSwiss = inSwitzerland && !tilePredominantlyFrench && shouldUseSwiss(z, tileCenterLat);
    const raceIGNBorderTile = considerSwiss && tileTrulyTouchesFrance && useFranceMNS;
    let ignResultPromise = null;
    if (raceIGNBorderTile) {
      ignResultPromise = buildIGNTile(z, x, y, franceClass, requestPurpose, mapTile);
    }
    if (z >= 12 && typeof swLog !== 'undefined' && swLog.isDebug()) {
      swLog.debug(
        'dispatch',
        `%c ${z}/${x}/${y} %c inFrance(bbox)=${inFrance} franceClass=${franceClass} ctrInFR=${tileCenterInFrancePoly} trulyFR=${tileTrulyTouchesFrance} predomFR=${tilePredominantlyFrench} inSwitz=${inSwitzerland} considerSwiss=${considerSwiss} raceIGN=${raceIGNBorderTile}`,
        'background:#444;color:#fff;padding:1px 4px;border-radius:2px', '',
      );
    }
    if (considerSwiss) {
      const swissResult = await buildSwissTile(z, x, y);
      if (swissResult && swissResult.elevations) {
        swissHadSomeData = true;
        await acquireComposite();
        try {
          // Les tuiles nationales intérieures encodent le datum suisse brut,
          // invariant selon le LOD (pas de biais Mapbox par tuile), pour que des
          // tuiles voisines rendues à des LOD différents ne s'écartent pas — voir
          // compositeIGNMapbox(). Les tuiles de bord sont en couverture partielle
          // → le chemin de fondu gère la transition vers Mapbox quel que soit cet
          // indicateur.
          pngBlob = await compositeIGNMapbox(
            swissResult.elevations, swissResult.coverage, z, x, y,
            { skipDatumBias: true },
          );
        } finally {
          releaseComposite();
        }
        demSource = 'swiss-composite';
      } else {
        if (swissResult?.source === 'swiss-unavailable') swissTransientFailure = true;
        if (typeof swLog !== 'undefined' && swLog.isDebug()) {
          swLog.debug(
            'dispatch',
            `%c ${z}/${x}/${y} %c swiss result=${swissResult?.source || 'null'} → falling through`,
            'background:#FF9800;color:#fff;padding:1px 4px;border-radius:2px', '',
          );
        }
      }
    }

    // ── Branche Norvège — MNT national à 1 m via les services WCS ouverts dans
    // les zones officielles EUREF89 / UTM 32, 33 et 35. Contrairement à la
    // France / la Suisse, pas besoin ici d'un modèle de source composée propre au
    // pays : le WCS sert déjà une grille rectifiée pour l'emprise de la tuile
    // Mercator demandée.
    let norwayHadSomeData = false;
    let norwayTransientFailure = false;
    const considerNorway = inNorway && shouldUseNorway(z, tileCenterLat);
    if (!pngBlob && considerNorway) {
      const norwayResult = await buildNorwayTile(z, x, y);
      if (norwayResult?.elevations) {
        norwayHadSomeData = true;
        await acquireComposite();
        try {
          // Raw, LOD-invariant Norway DTM datum on interior tiles (see
          // Swiss branch / compositeIGNMapbox comment).
          pngBlob = await compositeIGNMapbox(
            norwayResult.elevations,
            norwayResult.coverage,
            z,
            x,
            y,
            { skipDatumBias: true },
          );
        } finally {
          releaseComposite();
        }
        demSource = norwayResult.source || 'norway-dtm-composite';
      } else if (norwayResult?.source === 'norway-unavailable') {
        norwayTransientFailure = true;
      }
    }

    // ── Branche Espagne — MDT national à 5 m depuis le WCS INSPIRE.
    let spainHadSomeData = false;
    let spainTransientFailure = false;
    considerSpain = inSpain && !tilePredominantlyFrench && shouldUseSpain(z, tileCenterLat);
    const spainBorderFillEligible =
      inSpain
      && tilePredominantlyFrench
      && shouldUseSpain(z, tileCenterLat);
    let spainBorderFillPromise = null;
    if (spainBorderFillEligible) {
      spainBorderFillPromise = buildSpainTile(z, x, y).catch(() => null);
    }
    if (!pngBlob && considerSpain) {
      const spainResult = await buildSpainTile(z, x, y);
      if (spainResult?.elevations) {
        spainHadSomeData = true;
        await acquireComposite();
        try {
          // Datum MDT espagnol brut, invariant selon le LOD, sur les tuiles
          // intérieures (voir la branche suisse / le commentaire de
          // compositeIGNMapbox). C'est ce chemin qui rétablit un relief de 1 à 5 m
          // au lieu de la surface biaisée par tuile qui faisait des marches entre LOD.
          pngBlob = await compositeIGNMapbox(
            spainResult.elevations,
            spainResult.coverage,
            z,
            x,
            y,
            { skipDatumBias: true },
          );
        } finally {
          releaseComposite();
        }
        demSource = spainResult.source || 'spain-mdt-composite';
      } else if (spainResult?.source === 'spain-unavailable') {
        spainTransientFailure = true;
      }
    }

    if (!pngBlob && tileTrulyTouchesFrance && useFranceMNS) {
      const ignResult = ignResultPromise
        ? await ignResultPromise
        : await buildIGNTile(z, x, y, franceClass, requestPurpose, mapTile);
      // Annulée et non réessayée : la carte n'attend plus cette tuile (ou les
      // nouvelles tentatives sont épuisées). On n'enregistre rien — ni
      // remplaçant, ni repli sol nu ou à 30 m : la prochaine demande de la tuile
      // la construira de zéro.
      if (ignResult?.cancelled) {
        if (mapTile && isMapDemTileWanted(mapTile)) {
          scheduleSurfaceMnsRecovery(cache, cacheKey, z, x, y, franceClass, demProfile);
        }
        return noTileResponse(DEM_CANCELLED_REASON);
      }
      if (ignResult) {
        upgradePending = ignResult.pendingFetches;
        if (ignResult.pendingFetches?.length) upgradeSourceHint = 'ign';
        if (ignResult.elevations) {
          ignHadSomeData = true;
          franceHadSomeData = true;
          // Construite par l'ancien chemin MNS de corrélation parce que le WMS
          // LiDAR HD a échoué passagèrement (délai dépassé, 5xx) : plus grossière,
          // en partie préremplie à 30 m. Provisoire comme les remplaçants
          // ci-dessous — brièvement en cache puis reconstruite depuis le WMS — au
          // lieu d'être la réponse définitive de la tuile.
          if (isProvisionalMnsBuild(ignResult, z, x, y)) {
            franceSurfaceTransient = true;
          }
          if (spainBorderFillPromise && !ignResult.blob) {
            try {
              const sp = await spainBorderFillPromise;
              if (sp?.elevations && sp?.coverage) {
                const cov = ignResult.coverage;
                const elv = ignResult.elevations;
                let merged = 0;
                for (let i = 0; i < cov.length; i++) {
                  if (!cov[i] && sp.coverage[i]) {
                    elv[i] = sp.elevations[i];
                    cov[i] = 1;
                    merged++;
                  }
                }
                if (merged > 0) {
                  spainHadSomeData = true;
                  if (typeof swLog !== 'undefined' && swLog.isDebug()) {
                    swLog.debug(
                      'dispatch',
                      `%c ${z}/${x}/${y} %c IGN+Spain merged ${merged} px`,
                      'background:#A63A00;color:#fff;padding:1px 4px;border-radius:2px', '',
                    );
                  }
                }
              }
            } catch { /* best-effort */ }
            spainBorderFillPromise = null;
          }
          if (ignResult.blob) {
            pngBlob = ignResult.blob;
            demSource = ignResult.source || 'ign';
          } else {
            await acquireComposite();
            try {
              pngBlob = await compositeIGNMapbox(
                ignResult.elevations, ignResult.coverage, z, x, y,
                { skipDatumBias: franceClass === 'inside', prefilledMbElev: ignResult.prefilledMbElev },
              );
            } finally {
              releaseComposite();
            }
            demSource = 'ign-composite';
          }
        }
        if (!ignHadSomeData && ignResult.allPermanent404) {
          mnsAreaNegSet(z, x, y);
        } else if (!ignHadSomeData) {
          franceTransientFailure = true;
          franceSurfaceTransient = true;
        }
      } else {
        franceTransientFailure = true;
        franceSurfaceTransient = true;
      }
    }

    // 3-. Remplaçant de surface : overzoom d'un ancêtre DÉJÀ construit (la tuile
    // que l'utilisateur regardait avant de zoomer), pour que les bâtiments
    // restent à l'écran. Cache seulement — une construction récursive du parent
    // mettrait un autre raster WMS en file derrière celui qui vient d'échouer.
    // Sa source `overzoom-*` fait que finalize() ne le garde que brièvement, et la
    // récupération de surface programmée plus bas le remplace par la vraie tuile MNS.
    if (!pngBlob && franceSurfaceTransient) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile, { cachedOnly: true });
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-surface-standin';
      }
    }

    if (!pngBlob && spainBorderFillPromise && !ignHadSomeData) {
      try {
        const sp = await spainBorderFillPromise;
        if (sp?.elevations && sp?.coverage) {
          spainHadSomeData = true;
          await acquireComposite();
          try {
            pngBlob = await compositeIGNMapbox(sp.elevations, sp.coverage, z, x, y);
          } finally {
            releaseComposite();
          }
          demSource = sp.source ? `${sp.source}-border-rescue` : 'spain-mdt-border-rescue';
        } else if (sp?.source === 'spain-unavailable') {
          spainTransientFailure = true;
        }
      } catch { /* best-effort */ }
      spainBorderFillPromise = null;
    }

    // 3a. Chemin terrain vérifié pour le calcul des pentes et repli LiDAR uniforme à 1 m.
    if (!pngBlob && tileTrulyTouchesFrance && (useFranceTerrainWms || useFranceMNS || useFranceHighres)) {
      const terrainResult = await buildIGNTerrainTile(z, x, y, { purpose: requestPurpose, mapTile });
      if (terrainResult?.cancelled) return noTileResponse(DEM_CANCELLED_REASON);
      if (terrainResult?.elevations) {
        franceHadSomeData = true;
        await acquireComposite();
        try {
          pngBlob = await compositeIGNMapbox(terrainResult.elevations, terrainResult.coverage, z, x, y);
        } finally {
          releaseComposite();
        }
        demSource = 'ign-rgealti-wms-composite';
      } else {
        franceTransientFailure = true;
      }
    }

    // 3b. WMTS terrain fallback.
    if (!pngBlob && tileTrulyTouchesFrance && useFranceHighres && !ignHadSomeData) {
      const highresResult = await buildIGNFallbackTile(z, x, y);
      if (highresResult) {
        if (highresResult.elevations) {
          franceHadSomeData = true;
          if (highresResult.blob) {
            pngBlob = highresResult.blob;
            demSource = highresResult.source || 'ign-highres';
          } else {
            await acquireComposite();
            try {
              pngBlob = await compositeIGNMapbox(highresResult.elevations, highresResult.coverage, z, x, y);
            } finally {
              releaseComposite();
            }
            demSource = 'ign-highres-composite';
          }
        }
        if (highresResult.pendingFetches) {
          upgradeSourceHint = 'ign-highres';
          upgradePending = upgradePending
            ? [...upgradePending, ...highresResult.pendingFetches]
            : highresResult.pendingFetches;
        }
      }
    }

    if (!pngBlob && tileIsInFrance && z >= MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-lidar-parent';
      }
    }

    if (!pngBlob && inSwitzerland && !tileTrulyTouchesFrance && z >= MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-swiss-parent';
      }
    }

    if (!pngBlob && inNorway && z >= MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-norway-parent';
      }
    }

    if (!pngBlob && considerSpain) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-spain-parent';
      }
    }

    // 4. Repli mondial Mapbox — seulement à faible zoom ou hors de FR/CH/NO/ES.
    const globalHighZoomParentMesh =
      z > MAPBOX_DEM_MAXZOOM
      && !tileTrulyTouchesFrance
      && !inSwitzerland
      && !inNorway
      && !considerSpain;
    const lidarRegionEngaged =
      (tileTrulyTouchesFrance && (franceHadSomeData || franceTransientFailure)) ||
      (inSwitzerland && !tileTrulyTouchesFrance && (swissHadSomeData || swissTransientFailure)) ||
      (inNorway && (norwayHadSomeData || norwayTransientFailure)) ||
      (considerSpain && (spainHadSomeData || spainTransientFailure));
    const skipMapboxHighZoomLiDAR = lidarRegionEngaged;
    const allowGlobalFallbackTile = !globalHighZoomParentMesh && !skipMapboxHighZoomLiDAR;
    if (!pngBlob && allowGlobalFallbackTile) {
      pngBlob = await fetchAWSTerrainTile(z, x, y);
      if (pngBlob) demSource = 'aws-terrarium';
    }

    // 5. Single-step parent overzoom (outside-LiDAR & low-zoom path).
    if (!pngBlob && allowGlobalFallbackTile) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source;
      }
    }

    // 5b. Emergency degraded-parent — last resort.
    if (!pngBlob && lidarRegionEngaged && z >= MAPBOX_DEM_MAXZOOM) {
      try {
        const emergency = await fetchAWSTerrainTile(z, x, y);
        if (emergency) {
          pngBlob = emergency;
          demSource = 'aws-emergency-parent';
          forceShortCache = true;
          healthStatus = 'degraded';
          if (typeof swLog !== 'undefined' && swLog.isDebug()) {
            swLog.warn(
              'emergency',
              `%c DEGRADED PARENT %c ${z}/${x}/${y} — LiDAR transient + no cached parent, serving AWS 30m with shortCache=15s`,
              'background:#FF6F00;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold', '',
            );
          }
        }
      } catch { /* au mieux — on continue jusqu'à la 204 */ }
    }

    // 5c. Tout ce qui remplace une construction de surface ratée (overzoom du
    // parent, MNT sol nu, AWS) est provisoire : on le garde brièvement en cache
    // pour qu'il ne devienne jamais la réponse définitive de la tuile ni un parent
    // pour les zooms plus profonds, et on reconstruit la vraie tuile MNS en
    // arrière-plan (la page la recharge sur DEM_TILE_CACHE_UPDATED).
    if (franceSurfaceTransient) {
      if (pngBlob) forceShortCache = true;
      if (_depth === 0) scheduleSurfaceMnsRecovery(cache, cacheKey, z, x, y, franceClass, demProfile);
    }

    // 6. Rien n'a marché — 204 avec un TTL court pour les échecs passagers.
    if (!pngBlob) {
      const isConfirmedEmpty = globalHighZoomParentMesh || (!tileIsInFrance && !inSwitzerland && !inNorway && !considerSpain);
      const ttl = isConfirmedEmpty ? NEGATIVE_TTL_CONFIRMED : NEGATIVE_TTL_PIPELINE;
      const reason = globalHighZoomParentMesh
        ? 'global-parent-mesh'
        : skipMapboxHighZoomLiDAR
        ? (tileIsInFrance
            ? 'ign-pending-highzoom'
            : (inNorway
                ? 'norway-pending-highzoom'
                : (considerSpain ? 'spain-pending-highzoom' : 'swiss-pending-highzoom')))
        : ((tileIsInFrance || inSwitzerland || inNorway || considerSpain) ? 'pipeline-error' : 'no-coverage');
      if (upgradePending && upgradePending.length) {
        scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint, demProfile);
      }
      const isAborted = Boolean(_request?.signal?.aborted);
      if (!isAborted && isConfirmedEmpty) {
        negCache.put(cacheKey, new Response(null, {
          status: 204,
          headers: {
            'x-cached-at': String(Date.now()),
            'x-neg-ttl': String(ttl),
          },
        }));
      }
      if (typeof swLog !== 'undefined' && swLog.isDebug()) {
        const dt = (performance.now() - t0).toFixed(0);
        swLog.debug('dispatch', `204 ${z}/${x}/${y} reason=${reason} ttl=${ttl}s ${dt}ms (aborted=${isAborted})`);
      }
      return noTileResponse(isAborted ? 'aborted' : reason);
    }

    const preGuardShortCache = forceShortCache;
    const preGuardHealthStatus = healthStatus;
    const guarded = await guardDemTileHealth(cache, pngBlob, z, x, y, demSource, demProfile);
    if (!guarded.blob) {
      if (upgradePending && upgradePending.length) {
        scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint || demSource, demProfile);
      }
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: {
          'x-cached-at': String(Date.now()),
          'x-neg-ttl': String(NEGATIVE_TTL_PIPELINE),
        },
      }));
      return noTileResponse(guarded.reason || 'health-guard');
    }

    pngBlob = guarded.blob;
    demSource = guarded.demSource;
    forceShortCache = preGuardShortCache || guarded.shortCache;
    healthStatus = guarded.healthStatus !== 'ok' ? guarded.healthStatus : preGuardHealthStatus;

    return finalize(
      cache,
      cacheKey,
      t0,
      z,
      x,
      y,
      pngBlob,
      demSource,
      upgradePending,
      tileIsInFrance || inSwitzerland || inNorway || considerSpain,
      upgradeSourceHint,
      forceShortCache,
      healthStatus,
      demProfile,
    );
  } catch (err) {
    if (typeof swLog !== 'undefined') {
      swLog.error('dispatch', `error ${z}/${x}/${y}`, err);
    } else {
      console.error('[sw-dem] error', z, x, y, err);
    }
    const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
    if (fb) {
      return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, tileIsInFrance || inSwitzerland || inNorway || considerSpain, '', false, 'ok', demProfile);
    }
    return noTileResponse('error');
  }
}
