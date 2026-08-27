// ---------------------------------------------------------------------------
// DEM tile handler — heavy request pipeline for /dem-tiles/{z}/{x}/{y}.
//
// Routing priority (high → low):
//   1. positive cache  (TTL respects x-cache-ttl-ms for transient tiles)
//   2. negative cache  (TTL-bounded, with a single overzoom rescue try)
//   3. Switzerland LiDAR DSM via swissSURFACE3D (if tile inside CH)
//   4. Norway national DTM via Kartverket / Geonorge WCS (if tile inside NO)
//   5. Spain national MDT 5 m via IGN / IDEE WCS (if tile inside ES)
//   6. France IGN MNS / RGE ALTI / WMTS-fallback pipelines
//   7. LiDAR-preserving parent overzoom inside FR/CH/NO/ES at z > MAPBOX_DEM_MAXZOOM
//   8. AWS Terrarium global fallback
//   9. Final parent overzoom on outside-LiDAR / low-zoom path
//   10. 204 + negative cache
//
// Split out of runtime/dem-handler.js into runtime/dem-handler/ (May 15).
// ---------------------------------------------------------------------------

async function computeDemRequest(_request, z, x, y, _depth, demProfile) {
  const t0 = performance.now();
  const requestPurpose = resolveDemRequestPurposeFromRequest(_request);
  const inLiDARRiskRegion = isExpertFallbackRiskTile(z, x, y);
  const cacheKey = buildDemCacheKey(z, x, y, demProfile);
  const hotKey = cacheKey.url;

  // 0. Hot in-memory tier — see DEM_HOT_CACHE in runtime/lifecycle.js.
  // Returns a fresh Response in <1 ms, sparing the SW thread an entire
  // CacheStorage round-trip (open + match ≈ 5-25 ms each) for the very
  // common case of re-displaying tiles the user just panned past.
  // Hits never need negative-cache or France-classification lookups
  // because the hot entry was only written by `finalize()` for a
  // confirmed pipeline success.
  const hot = demHotGet(hotKey);
  if (hot) return demHotResponse(hot);

  // 1+2. CacheStorage tiers — open BOTH caches and look up BOTH keys in
  // parallel. Sequential awaits used to add up to ~30-50 ms per tile on
  // disk-backed CacheStorage; for a 100-tile pan that was 3-5 s of pure
  // I/O latency on the SW thread, even when every lookup ultimately
  // missed (cold session) or every one hit (warm re-display).
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
      // Promote to hot tier so the next request skips CacheStorage.
      // We clone() because a Response body is single-shot — returning the
      // original lets the caller read it; the clone goes to the hot tier.
      try { demHotPut(hotKey, await cached.clone().blob(), Array.from(cached.headers.entries())); } catch { /* ignore */ }
      return cached;
    }

    const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
    if (cachedAt > 0 && (Date.now() - cachedAt) < ttlMs) return cached;

    await cache.delete(cacheKey);
  }

  // 2. Negative cache (TTL-bounded)
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
  const inOverseasFrance = tileOverlapsOverseasFrance(z, x, y);
  const inSwitzerland = tileOverlapsSwitzerland(z, x, y);
  const inNorway = tileOverlapsNorway(z, x, y);
  const inSpain = tileOverlapsSpain(z, x, y);
  let tileIsInFrance = false; // hoisted so catch-handler can use it for finalize()
  let considerSpain = false;
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
    const useFranceTerrainWms = useFranceTerrainOnly && shouldUseIGNTerrainWms(z, tileCenterLat);
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
    } else if (inOverseasFrance && useFranceHighres) {
      // Overseas French territories (REU/GLP/MTQ/MYT/GUF) — france-border.json
      // is metro-only so the polygon test would always answer "outside" and
      // skip the IGN HD path. We treat the whole bbox as 'inside' (no CH/NO/ES
      // disambiguation needed — these bboxes don't overlap any other national
      // pipeline) so buildIGNTile runs without the per-pixel polygon clip.
      franceClass = 'inside';
      tileCenterInFrancePoly = true;
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

    // ── Switzerland branch — runs when the tile is over the Swiss LV95
    // footprint AND not predominantly French. Border tiles where the
    // French polygon claims the centre still go to IGN.
    let swissHadSomeData = false;
    let swissTransientFailure = false; // STAC/header timeout; do NOT cache Mapbox flat as the answer
    const considerSwiss = inSwitzerland && !tilePredominantlyFrench && shouldUseSwiss(z, tileCenterLat);
    const raceIGNBorderTile = considerSwiss && tileTrulyTouchesFrance && useFranceMNS;
    let ignResultPromise = null;
    if (raceIGNBorderTile) {
      ignResultPromise = buildIGNTile(z, x, y, franceClass, requestPurpose);
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
          // Interior national tiles encode the raw, LOD-invariant Swiss
          // datum (no per-tile Mapbox bias) so neighbouring tiles rendered
          // at different LOD don't step apart — see compositeIGNMapbox().
          // Border tiles are partial coverage → blend path handles the
          // Mapbox transition regardless of this flag.
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
        console.log(
          `[sw-dem][dispatch] %c ${z}/${x}/${y} %c swiss result=${swissResult?.source || 'null'} → falling through`,
          'background:#FF9800;color:#fff;padding:1px 4px;border-radius:2px', '',
        );
      }
    }

    // ── Norway branch — national 1 m DTM via open WCS services in the
    // official EUREF89 / UTM 32, 33 and 35 zones. Unlike France/CH we do not
    // need a country-specific composite source model here: the WCS already
    // serves a rectified grid for the requested Mercator tile footprint.
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

    // ── Spain branch — national MDT 5 m from the INSPIRE WCS.
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
          // Raw, LOD-invariant Spain MDT datum on interior tiles (see
          // Swiss branch / compositeIGNMapbox comment). This is the path
          // that restores 1–5 m relief instead of the per-tile-biased
          // surface that stepped between LODs.
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
        : await buildIGNTile(z, x, y, franceClass, requestPurpose);
      if (ignResult) {
        upgradePending = ignResult.pendingFetches;
        if (ignResult.pendingFetches?.length) upgradeSourceHint = 'ign';
        if (ignResult.elevations) {
          ignHadSomeData = true;
          franceHadSomeData = true;
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
                  if (DEBUG) {
                    console.log(
                      `[sw-dem][border-fill] %c ${z}/${x}/${y} %c IGN+Spain merged ${merged} px`,
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
        }
      } else {
        franceTransientFailure = true;
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

    // 3a. Verified terrain path for slope math & uniform 1m LiDAR fallback.
    if (!pngBlob && tileTrulyTouchesFrance && (useFranceTerrainWms || useFranceMNS || useFranceHighres)) {
      const terrainResult = await buildIGNTerrainTile(z, x, y, { purpose: requestPurpose });
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

    // 4. Mapbox global fallback — only at low zoom or outside France/CH/NO/ES.
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
          if (DEBUG) {
            console.warn(
              `[sw-dem][emergency] %c DEGRADED PARENT %c ${z}/${x}/${y} — LiDAR transient + no cached parent, serving AWS 30m with shortCache=15s`,
              'background:#FF6F00;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold', '',
            );
          }
        }
      } catch { /* best-effort — fall through to 204 */ }
    }

    // 6. Nothing worked — 204 with short TTL for transient failures.
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
      if (!isAborted) {
        negCache.put(cacheKey, new Response(null, {
          status: 204,
          headers: {
            'x-cached-at': String(Date.now()),
            'x-neg-ttl': String(ttl),
          },
        }));
      }
      if (DEBUG) {
        const dt = (performance.now() - t0).toFixed(0);
        console.warn(`[sw-dem] 204 ${z}/${x}/${y} reason=${reason} ttl=${ttl}s ${dt}ms (aborted=${isAborted})`);
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
    console.error('[sw-dem] error', z, x, y, err);
    const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
    if (fb) {
      return finalize(cache, cacheKey, t0, z, x, y, fb.blob, fb.source, null, tileIsInFrance || inSwitzerland || inNorway || considerSpain, '', false, 'ok', demProfile);
    }
    return noTileResponse('error');
  }
}
