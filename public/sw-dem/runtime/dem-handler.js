// ---------------------------------------------------------------------------
// DEM tile handler — top-level dispatcher for /dem-tiles/{z}/{x}/{y}.
//
// Routing priority (high → low):
//   1. positive cache  (TTL respects x-cache-ttl-ms for transient tiles)
//   2. negative cache  (TTL-bounded, with a single overzoom rescue try)
//   3. Switzerland LiDAR DSM via swissSURFACE3D (if tile inside CH)
//   4. France IGN MNS / RGE ALTI / WMTS-fallback pipelines
//   5. LiDAR-preserving parent overzoom inside FR/CH at z > MAPBOX_DEM_MAXZOOM
//   6. AWS Terrarium global fallback
//   7. Final parent overzoom on outside-LiDAR / low-zoom path
//   8. 204 + negative cache
//
// In-flight coalescing (DEM_INFLIGHT, declared in lifecycle.js): identical
// concurrent requests for the same (z, x, y, demProfile) share a single
// pipeline run instead of fanning out into N independent dispatcher cycles.
// This was the dominant root cause of the slope-tile pill stalling at ~85%
// on cold viewport: every slope tile was pre-warming 4 neighbour DEMs and
// the 5×-amplification saturated the fetch / composite queues so that
// genuine slope responses missed the Mapbox tile-load deadline.
//
// Split out of sw-dem.js (May 03).
// ---------------------------------------------------------------------------

async function handleDemRequest(_request, z, x, y, _depth, demProfile) {
  if (_depth === undefined) _depth = 0;
  if (!demProfile) demProfile = resolveDemProfileFromRequest(_request);

  // World-zoom short-circuit: no visible terrain relief below z4, and at that
  // zoom Mapbox tiles are tiny fractions of the globe. Returning 204 instantly
  // lets Mapbox GL reuse parent/empty meshes and prevents the SW from ever
  // blocking the Standard-Satellite base-map fetches on origin contention
  // during fast pinch-zoom-out (root cause of the "white earth" symptom).
  if (z < 4) return noTileResponse('world-zoom');

  // ── In-flight coalescing — only at the top level. We deliberately skip
  // dedup for recursive overzoom calls (depth>0) because those carry their
  // own internal child requests and we don't want to deadlock by awaiting
  // ourselves through a Promise chain.
  if (_depth === 0) {
    const inflightKey = `${demProfile}:${z}/${x}/${y}`;
    const existing = DEM_INFLIGHT.get(inflightKey);
    if (existing) {
      try { return (await existing).clone(); }
      catch { /* fall through and recompute */ }
    }

    const work = computeDemRequest(_request, z, x, y, _depth, demProfile);
    DEM_INFLIGHT.set(inflightKey, work);
    try {
      const response = await work;
      return response.clone();
    } finally {
      DEM_INFLIGHT.delete(inflightKey);
    }
  }

  return computeDemRequest(_request, z, x, y, _depth, demProfile);
}

async function computeDemRequest(_request, z, x, y, _depth, demProfile) {
  const t0 = performance.now();
  const inLiDARRiskRegion = isExpertFallbackRiskTile(z, x, y);
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = buildDemCacheKey(z, x, y, demProfile);

  // 1. Positive cache
  const cached = await cache.match(cacheKey);
  if (cached) {
    const ttlMs = parseInt(cached.headers.get('x-cache-ttl-ms') || '0', 10);
    if (!ttlMs) return cached;

    const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
    if (cachedAt > 0 && (Date.now() - cachedAt) < ttlMs) return cached;

    await cache.delete(cacheKey);
  }

  // 2. Negative cache (TTL-bounded)
  const negCache = await caches.open(NEGATIVE_CACHE_NAME);
  const negCached = await negCache.match(cacheKey);
  if (negCached) {
    const age = parseInt(negCached.headers.get('x-cached-at') || '0', 10);
    const ttl = parseInt(negCached.headers.get('x-neg-ttl') || String(NEGATIVE_TTL_PIPELINE), 10);
    if (age && (Date.now() - age) < ttl * 1000) {
      // Try overzoom once, else honour the negative cache
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, inLiDARRiskRegion, '', false, 'ok', demProfile);
      return noTileResponse('neg-cache');
    }
    negCache.delete(cacheKey);
  }

  const inFrance = tileOverlapsFrance(z, x, y);
  const inSwitzerland = tileOverlapsSwitzerland(z, x, y);
  let tileIsInFrance = false; // hoisted so catch-handler can use it for finalize()
  try {
    let pngBlob;
    let demSource = 'none';
    let forceShortCache = false;
    let healthStatus = 'ok';

    // 3. IGN France pipeline — gated by pixel-density, not a hardcoded zoom.
    // shouldUseIGN(z, lat) returns true when the rendered pixel is smaller
    // than Mapbox's ~30 m native sample distance, so we invest IGN cost only
    // where LiDAR detail is actually visible. Latitude-aware: handles Corsica
    // (low lat, earlier crossover) and Dunkirk (high lat, later crossover)
    // with the same continuous function instead of a magic-number zoom.
    let upgradePending = null; // in-flight IGN sub-tile fetches for background re-cache
    let upgradeSourceHint = '';
    let ignHadSomeData = false; // true when MNS returned partial/full coverage
    let franceHadSomeData = false;
    let franceTransientFailure = false; // IGN timed out / partially settled; keep parent mesh instead of caching flat AWS child
    const tileBounds = mercatorTileBounds(z, x, y);
    const tileCenterLat = (tileBounds.north + tileBounds.south) / 2;
    const useFranceTerrainOnly = demProfile === 'terrain';
    const useFranceMNS = !useFranceTerrainOnly && shouldUseIGN(z, tileCenterLat);
    const useFranceHighres = useFranceMNS || shouldUseIGNHighres(z, tileCenterLat);

    // ── Resolve France polygon classification UP-FRONT.
    // tileOverlapsFrance() is a generous bbox check that ALSO covers most of
    // Switzerland (FRANCE_BOUNDS is [-5.5, 41, 10.0, 51.5]). The previous
    // version of this dispatcher used `!inFrance` to gate the Swiss branch,
    // which silently disabled it across ~95 % of CH. The polygon test below
    // is the authoritative "is this tile actually inside France" answer and
    // is what gates both branches now.
    let franceClass = 'outside';
    let tileCenterInFrancePoly = false;
    if (inFrance && useFranceHighres) {
      if (await ensureFrancePoly()) {
        franceClass = classifyDemTile(z, x, y);
        // classifyDemTile() promotes any z≥12 tile that overlaps the France
        // BBOX to 'border' even when the polygon contains 0 sample points
        // (deliberate safety net for sub-100 m summit tiles whose 6×6
        // sampling can miss a French sliver near Mont-Blanc/Pyrénées).
        // That promotion ALSO catches the entire Swiss plateau because
        // FRANCE_BOUNDS extends east to lng=10.0. We therefore additionally
        // test the tile centre against the polygon to know whether the
        // tile is *predominantly* French (→ IGN wins) or merely brushes
        // the bbox (→ Swiss wins when the tile is in CH).
        const centerLng = (tileBounds.west + tileBounds.east) / 2;
        const centerLat = (tileBounds.north + tileBounds.south) / 2;
        tileCenterInFrancePoly = pointInFrance(centerLng, centerLat);
      }
    }
    // tileIsInFrance: any French overlap (used for IGN gating, finalize
    // flags). Border tiles still go through IGN even when the centre is
    // in CH, because IGN MNS may cover the French strip.
    tileIsInFrance = franceClass !== 'outside';
    // tilePredominantlyFrench: only true when the tile centre actually
    // sits inside France polygon (or the polygon fully covers the tile).
    // Used to decide who *wins* between Swiss and IGN when both could run.
    const tilePredominantlyFrench = franceClass === 'inside' || tileCenterInFrancePoly;

    // ── Stricter "tile actually overlaps France polygon" test.
    //
    // classifyDemTile() promotes any z≥12 tile inside the FRANCE_BOUNDS
    // bbox (-5.5..10.0 lng) to 'border' as a safety-net for Mont-Blanc /
    // Pyrenees summit tiles where 6×6 polygon sampling can miss a French
    // sliver. Side-effect: tiles deep inside Switzerland (Sion at lng 7.3
    // is ~50 km east of France) ALSO get franceClass='border', so
    // tileIsInFrance flips true, raceIGNBorderTile fires, IGN burns the
    // request slot pool serially while Swiss STAC times out at 8 s.
    //
    // tileTrulyTouchesFrance: explicit polygon test on the tile centre
    // and 4 mid-edge points. If all 5 are outside France polygon AND
    // we're firmly inside CH, IGN has zero plausible data for the tile
    // — skip the race AND skip the post-Swiss IGN fallback entirely so
    // Swiss gets all the bandwidth.
    let tileTrulyTouchesFrance = tileIsInFrance;
    if (tileIsInFrance && franceClass === 'border' && inSwitzerland) {
      // franceClass=='border' implies ensureFrancePoly() succeeded above,
      // so pointInFrance() is safe to call here.
      const cLng = (tileBounds.west + tileBounds.east) / 2;
      const cLat = (tileBounds.north + tileBounds.south) / 2;
      tileTrulyTouchesFrance =
        tileCenterInFrancePoly ||
        pointInFrance(tileBounds.west, cLat) ||
        pointInFrance(tileBounds.east, cLat) ||
        pointInFrance(cLng, tileBounds.north) ||
        pointInFrance(cLng, tileBounds.south);
    }

    // ── Switzerland branch — runs when the tile is over the Swiss LV95
    // footprint AND not predominantly French. Border tiles where the
    // French polygon claims the centre still go to IGN.
    let swissHadSomeData = false;
    let swissTransientFailure = false; // STAC/header timeout; do NOT cache Mapbox flat as the answer
    const considerSwiss = inSwitzerland && !tilePredominantlyFrench && shouldUseSwiss(z, tileCenterLat);
    // Race IGN in parallel only for tiles that genuinely straddle the
    // French border polygon — not for every CH tile that bbox-overlaps
    // FRANCE_BOUNDS. This frees the IGN/network queue for Swiss STAC.
    const raceIGNBorderTile = considerSwiss && tileTrulyTouchesFrance && useFranceMNS;
    let ignResultPromise = null;
    if (raceIGNBorderTile) {
      ignResultPromise = buildIGNTile(z, x, y, franceClass);
    }
    if (z >= 12) {
      console.log(
        `[sw-dem][dispatch] %c ${z}/${x}/${y} %c inFrance(bbox)=${inFrance} franceClass=${franceClass} ctrInFR=${tileCenterInFrancePoly} trulyFR=${tileTrulyTouchesFrance} predomFR=${tilePredominantlyFrench} inSwitz=${inSwitzerland} considerSwiss=${considerSwiss} raceIGN=${raceIGNBorderTile}`,
        'background:#444;color:#fff;padding:1px 4px;border-radius:2px', '',
      );
    }
    if (considerSwiss) {
      const swissResult = await buildSwissTile(z, x, y);
      if (swissResult && swissResult.elevations) {
        swissHadSomeData = true;
        await acquireComposite();
        try {
          pngBlob = await compositeIGNMapbox(
            swissResult.elevations, swissResult.coverage, z, x, y,
          );
        } finally {
          releaseComposite();
        }
        demSource = 'swiss-composite';
      } else {
        // 'swiss-unavailable' = transient (STAC timeout, header retry exhausted,
        // range fetches died). Don't fall through to a cached Mapbox flat tile
        // at high zoom — that visually looks like a permanent flat patch next
        // to neighbours that worked. Treat it like an IGN transient miss:
        // skip Mapbox so we 204 with short TTL and Mapbox GL uses its own
        // parent mesh (a LiDAR tile from one zoom up).
        if (swissResult?.source === 'swiss-unavailable') swissTransientFailure = true;
        console.log(
          `[sw-dem][dispatch] %c ${z}/${x}/${y} %c swiss result=${swissResult?.source || 'null'} → falling through`,
          'background:#FF9800;color:#fff;padding:1px 4px;border-radius:2px', '',
        );
      }
    }

    // Use tileTrulyTouchesFrance (real polygon overlap) — not the bbox-promoted
    // tileIsInFrance — to gate IGN. Tiles deep inside CH (e.g. Sion) bbox-overlap
    // FRANCE_BOUNDS but have zero IGN data; running IGN there only burns the
    // request slot pool serially while Swiss STAC starves and times out.
    if (!pngBlob && tileTrulyTouchesFrance && useFranceMNS) {
      const ignResult = ignResultPromise
        ? await ignResultPromise
        : await buildIGNTile(z, x, y, franceClass);
      if (ignResult) {
        upgradePending = ignResult.pendingFetches;
        if (ignResult.pendingFetches?.length) upgradeSourceHint = 'ign';
        if (ignResult.elevations) {
          // MNS returned actual elevation data (partial or full coverage)
          ignHadSomeData = true;
          franceHadSomeData = true;
          if (ignResult.blob) {
            pngBlob = ignResult.blob;
            demSource = ignResult.source || 'ign';
          } else {
            await acquireComposite();
            try {
              pngBlob = await compositeIGNMapbox(ignResult.elevations, ignResult.coverage, z, x, y);
            } finally {
              releaseComposite();
            }
            demSource = 'ign-composite';
          }
        }
        // else: 0-coverage result — elevations is null. MNS had no data
        // for this tile. Record in area negative cache for fast skip on
        // adjacent tiles. Fall through to HIGHRES fallback below.
        if (!ignHadSomeData && ignResult.allPermanent404) {
          mnsAreaNegSet(z, x, y);
        } else if (!ignHadSomeData) {
          // Expert guard: if IGN didn't produce a usable child tile yet and
          // the miss is not a confirmed permanent 404, do NOT drop to the
          // global AWS path at z>MAPBOX_DEM_MAXZOOM. That caches a visually
          // flat child and breaks parent-mesh continuity on zoom-in.
          franceTransientFailure = true;
        }
      } else {
        franceTransientFailure = true;
      }
    }

    // 3a. Verified terrain path for slope math.
    // In `demProfile=terrain` we bypass the overzoomed WMTS fallback and use
    // the official RGE ALTI WMS directly as BIL32 for the exact tile bbox.
    if (!pngBlob && tileTrulyTouchesFrance && useFranceTerrainOnly) {
      const terrainResult = await buildIGNTerrainTile(z, x, y);
      if (terrainResult?.elevations) {
        franceHadSomeData = true;
        await acquireComposite();
        try {
          pngBlob = await compositeIGNMapbox(terrainResult.elevations, terrainResult.coverage, z, x, y);
        } finally {
          releaseComposite();
        }
        demSource = 'ign-rgealti-wms-composite';
      }
    }

    // 3b. WMTS terrain fallback — kept as a backup when the direct WMS
    // request fails or returns no usable coverage.
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
        // Merge pending fetches from HIGHRES (if any) with MNS pending
        if (highresResult.pendingFetches) {
          upgradeSourceHint = 'ign-highres';
          upgradePending = upgradePending
            ? [...upgradePending, ...highresResult.pendingFetches]
            : highresResult.pendingFetches;
        }
      }
    }

    // 3c. High-zoom-in-France LiDAR-preserving fallback.
    //
    // Problem we are solving: when IGN fails transiently on a single tile
    // inside France at mercZ > MAPBOX_DEM_MAXZOOM (queue prune, LiDAR-HD
    // nodata pocket, 10 s timeout) the legacy step 4 below would call
    // fetchMapboxTile(), which clamps to z14 and server-overzooms a flat
    // 30 m tile up to z15/16/17. That blob is geometrically smooth but
    // elevationally flat — EXACTLY the "je perds tout, 30 m en zoom-in"
    // symptom — and then it gets positive-cached for 1 week with
    // X-DEM-Source: mapbox, so the bad tile persists long after IGN
    // recovers.
    //
    // At this zoom the only admissible fallback is our OWN cache: mid-zoom
    // parent tiles (z ≤ 14) in France are already LiDAR-HD composites.
    // Bicubic-overzooming a z14 LiDAR tile to z15/16/17 preserves real relief
    // (rocks, ridgelines, couloirs) — infinitely better than stretching a
    // 30 m AWS/Mapbox pixel. This guard must start at z15, not z16: the
    // raster-dem source itself stops at z15, so the first zoom-in child tile
    // after a project load is already the critical threshold where a transient
    // IGN miss can flatten the terrain if we let it fall through to AWS.
    // If no LiDAR parent is available either, we return 204 with a very short
    // TTL so Mapbox GL falls back to its own cached parent mesh (which is
    // again the LiDAR blob one zoom level up) and retries the IGN pipeline on
    // the next pan/zoom.
    if (!pngBlob && tileIsInFrance && z >= MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-lidar-parent';
      }
    }

    // 3d. Same LiDAR-preserving path for Switzerland: at z15+ we never want
    // to fall through to a coarse fallback tile when we have a parent
    // COG-derived blob in our own cache. Use tileTrulyTouchesFrance (not
    // bbox-promoted tileIsInFrance) so deep-CH tiles still hit this path.
    if (!pngBlob && inSwitzerland && !tileTrulyTouchesFrance && z >= MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-swiss-parent';
      }
    }

    // 4. Mapbox global fallback — only at low zoom or outside France/CH.
    // Inside France/CH at mercZ > MAPBOX_DEM_MAXZOOM we skip this ONLY when
    // the LiDAR pipeline returned data. When neither LiDAR source had any
    // coverage, Mapbox overzoomed 30 m is better than nothing.
    const globalHighZoomParentMesh =
      z > MAPBOX_DEM_MAXZOOM
      && !tileTrulyTouchesFrance
      && !inSwitzerland;
    const skipMapboxHighZoomLiDAR =
      z >= MAPBOX_DEM_MAXZOOM && (
        (tileTrulyTouchesFrance && franceHadSomeData) ||
        // France transient failure: same policy as Switzerland. A high-zoom
        // IGN miss must preserve the parent LiDAR mesh, including at z15,
        // not cache a flat AWS child that only appears after zooming in.
        (tileTrulyTouchesFrance && franceTransientFailure) ||
        (inSwitzerland && !tileTrulyTouchesFrance && swissHadSomeData) ||
        // Swiss transient failure: do NOT cache a flat Mapbox tile in
        // place of an unbuilt LiDAR tile — visually indistinguishable
        // from a permanent flat patch (see screenshot Apr 24).
        (inSwitzerland && !tileTrulyTouchesFrance && swissTransientFailure)
      );
    const allowGlobalFallbackTile = !globalHighZoomParentMesh && !skipMapboxHighZoomLiDAR;
    // AWS Terrarium replaces Mapbox terrain-DEM globally. No token needed,
    // free public dataset, ~30 m worldwide. Mapbox SKU savings: ~−40 % of
    // Raster Tiles API. France/CH still use IGN/swissALTI for high zoom.
    // Outside LiDAR regions we stop at the dataset's native z14 detail and
    // let the renderer reuse the parent mesh above that. Synthesizing z15+
    // child DEM tiles in the SW progressively smooths the relief until the
    // terrain appears flat.
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

    // 6. Nothing worked — 204 with short TTL for transient failures, long for
    //    confirmed empty outside the supported LiDAR regions.
    if (!pngBlob) {
      const isConfirmedEmpty = globalHighZoomParentMesh || (!tileIsInFrance && !inSwitzerland);
      const ttl = isConfirmedEmpty ? NEGATIVE_TTL_CONFIRMED : NEGATIVE_TTL_PIPELINE;
      const reason = globalHighZoomParentMesh
        ? 'global-parent-mesh'
        : skipMapboxHighZoomLiDAR
        ? (tileIsInFrance ? 'ign-pending-highzoom' : 'swiss-pending-highzoom')
        : ((tileIsInFrance || inSwitzerland) ? 'pipeline-error' : 'no-coverage');
      if (upgradePending && upgradePending.length) {
        scheduleBackgroundUpgrade(cache, cacheKey, z, x, y, upgradePending, upgradeSourceHint, demProfile);
      }
      negCache.put(cacheKey, new Response(null, {
        status: 204,
        headers: {
          'x-cached-at': String(Date.now()),
          'x-neg-ttl': String(ttl),
        },
      }));
      if (DEBUG) {
        const dt = (performance.now() - t0).toFixed(0);
        console.warn(`[sw-dem] 204 ${z}/${x}/${y} reason=${reason} ttl=${ttl}s ${dt}ms`);
      }
      return noTileResponse(reason);
    }

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
    forceShortCache = guarded.shortCache;
    healthStatus = guarded.healthStatus;

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
      tileIsInFrance || inSwitzerland,
      upgradeSourceHint,
      forceShortCache,
      healthStatus,
      demProfile,
    );
  } catch (err) {
    console.error('[sw-dem] error', z, x, y, err);
    const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
    if (fb) {
      return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, tileIsInFrance || inSwitzerland, '', false, 'ok', demProfile);
    }
    return noTileResponse('error');
  }
}
