// ---------------------------------------------------------------------------
// DEM tile handler — top-level dispatcher for /dem-tiles/{z}/{x}/{y}.
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

  // ── Speculative-prefetch shedding under load ─────────────────────────
  //
  // Prefetch requests carry `?pf=1` (set by viewportPrefetch.ts). They are
  // SPECULATIVE — failing them silently is harmless: the next real Mapbox
  // request for the same tile will run the full pipeline normally.
  //
  // When the dispatcher is already saturated (DEM_INFLIGHT.size above the
  // soft cap), we drop incoming pf=1 immediately rather than enqueueing
  // them behind ~50 IGN sub-tile fetches. This is the SW-side defence
  // matching the browser-side prewarm-abort on user gesture: even if a
  // prewarm batch slips past gesture cancellation, it cannot starve the
  // foreground burst once the pipeline is already busy.
  //
  // Threshold rationale: a typical search-bar prewarm fires ≤14 tiles +
  // child/parent (~20 max). Mapbox's visible viewport at z14 60° pitch
  // peaks around 24 tiles. Setting the cap at 24 means: if real foreground
  // is actively flowing, prefetch yields. Below 24 (cold cache, idle map),
  // prefetch runs normally.
  if (_depth === 0 && _request) {
    let isPrefetch = false;
    try {
      isPrefetch = new URL(_request.url).searchParams.get('pf') === '1';
    } catch { /* ignore */ }
    if (isPrefetch && DEM_INFLIGHT.size >= 24) {
      return noTileResponse('prefetch-shed');
    }
  }

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
          pngBlob = await compositeIGNMapbox(
            norwayResult.elevations,
            norwayResult.coverage,
            z,
            x,
            y,
          );
        } finally {
          releaseComposite();
        }
        demSource = norwayResult.source || 'norway-dtm-composite';
      } else if (norwayResult?.source === 'norway-unavailable') {
        norwayTransientFailure = true;
      }
    }

    // ── Spain branch — national MDT 5 m from the INSPIRE WCS. The official
    // service exposes mainland / Balearic coverage in EPSG:25830 and Canary
    // coverage in EPSG:4083. Border policy: Spain runs whenever the tile is
    // not *predominantly* French. Tiles whose centre is on the Spanish side
    // of the Pyrenees were previously skipped here and re-routed to IGN MNS,
    // which has zero data south of the border — the Spanish half of those
    // tiles got composited against Mapbox 30 m and showed up as a flat
    // patch that never recovered ("Espagne plat au reload"). Predominantly
    // French border tiles still fall through to IGN below; we fire Spain in
    // parallel for them and merge it into the IGN coverage so the Spanish
    // strip is filled with native 5 m DEM instead of Mapbox 30 m.
    let spainHadSomeData = false;
    let spainTransientFailure = false;
    considerSpain = inSpain && !tilePredominantlyFrench && shouldUseSpain(z, tileCenterLat);
    const spainBorderFillEligible =
      inSpain
      && tilePredominantlyFrench
      && shouldUseSpain(z, tileCenterLat);
    let spainBorderFillPromise = null;
    if (spainBorderFillEligible) {
      // Fire-and-forget parallel fetch — awaited only if IGN actually ran
      // and produced partial coverage. Cheap (~131 KB / tile) thanks to
      // server-side scaleSize, deduped across slope/altitude pre-warm.
      spainBorderFillPromise = buildSpainTile(z, x, y).catch(() => null);
    }
    if (!pngBlob && considerSpain) {
      const spainResult = await buildSpainTile(z, x, y);
      if (spainResult?.elevations) {
        spainHadSomeData = true;
        await acquireComposite();
        try {
          pngBlob = await compositeIGNMapbox(
            spainResult.elevations,
            spainResult.coverage,
            z,
            x,
            y,
          );
        } finally {
          releaseComposite();
        }
        demSource = spainResult.source || 'spain-mdt-composite';
      } else if (spainResult?.source === 'spain-unavailable') {
        spainTransientFailure = true;
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
          // Border-tile Spain merge: fill any pixel that IGN left uncovered
          // (typically the Spanish strip of a Pyrenees border tile) with the
          // Spanish 5 m MDT before compositing. Without this the gap would
          // composite against Mapbox 30 m and surface as a flat patch.
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

    // 3a-bis. Spain rescue for predominantly-French tiles where IGN has no
    // data. The MNS LiDAR HD coverage stops at the actual French border, so
    // a tile whose centre is in France but whose only relief lives across
    // the ridge in Spain (Pic du Midi south slopes, Aneto north faces) used
    // to fall through here, eventually serve AWS 30 m, and look flat. The
    // Spain border-fill fetch was already kicked off earlier in parallel —
    // if IGN returned nothing usable, promote it to a primary source.
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
      } else {
        // Terrain WMS came back empty — could be a genuine WMS error, a
        // user-cancel from CANCEL_SLOPE_WORK aborting the in-flight slot,
        // or a queued entry that got pruned. In any of those cases the
        // 1 m slope pipeline has no usable input. Mark as transient so
        // step 4 below short-circuits the AWS Terrarium fallback and we
        // 204 instead of caching a flat 30 m tile under the
        // `?rv-dem-profile=terrain` slot (which would later show as a
        // flat slope when the user re-enables 1 m slope).
        franceTransientFailure = true;
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

    // 3e. Same parent-mesh preservation for Norway national DTM. A transient
    // WCS miss at z15+ must keep the last good parent mesh instead of caching
    // a coarse AWS child that flattens the relief while zooming in.
    if (!pngBlob && inNorway && z >= MAPBOX_DEM_MAXZOOM) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-norway-parent';
      }
    }

    // 3f. Spain MDT 5 m parent-mesh preservation. When the WCS transient
    // misses, prefer overzooming a previously cached Spain parent tile over
    // dropping to AWS Terrarium. Applies at every Spain-engaged zoom (z>=12),
    // not just z>=15: a transient failure at z=14 used to cache AWS as the
    // Spain slot for 30 days, then on zoom-in to z=15+ the parent-overzoom
    // rejected the AWS-tagged parent and the renderer fell back to the same
    // cached AWS z=14 — visually a 30 m blurred mesh that the user reads as
    // "the terrain went flat when I zoomed in over Spain".
    if (!pngBlob && considerSpain) {
      const fb = await tryParentOverzoom(cache, z, x, y, _depth, demProfile);
      if (fb) {
        pngBlob = fb.blob;
        demSource = fb.source + '-spain-parent';
      }
    }

    // 4. Mapbox global fallback — only at low zoom or outside France/CH/NO/ES.
    // Inside France/CH/NO/ES we skip this whenever the LiDAR pipeline either
    // already produced data OR transient-failed. The previous version only
    // skipped at `z >= MAPBOX_DEM_MAXZOOM` (15), which meant a single transient
    // Spain/IGN failure at z=12–14 would cache an AWS Terrarium tile under
    // the LiDAR slot for 30 days. Then on zoom-in to z=15+, parent-overzoom
    // correctly rejected the AWS-tagged parent (`shouldSkipUnsafeOverzoomParent`),
    // returned 204, and Mapbox's GPU fell back to the same cached AWS z=14 tile
    // — visually a 30 m blurred mesh that the user reads as "the terrain went
    // flat when I zoomed in over Spain".
    //
    // Now: if the tile is in a covered region AND the region's pipeline
    // engaged (had data OR transient-failed), we never let AWS Terrarium
    // poison the cache slot — we 204 with a short TTL so the next request
    // hits the LiDAR pipeline again. AWS only fills the slot when the region
    // truly has no data and we're below the renderer's max zoom (z<15).
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

    // 5b. Emergency degraded-parent — last resort to defeat "flat-on-zoom-in"
    //     during a cold viewport over a LiDAR region.
    //
    // Failure path we are catching:
    //   - User opens a project at z15-17 over the Alps. Mapbox's tile pyramid
    //     is empty (no parent z14 cached yet on cold load).
    //   - The IGN MNS pipeline transient-fails on the first burst (queue
    //     saturation + soft deadline) → franceTransientFailure=true.
    //   - tryParentOverzoom recursively walks z-1, z-2... but every parent
    //     ALSO runs the saturated IGN pipeline → also 204s → no LiDAR
    //     parent in our cache to overzoom.
    //   - Pipeline reaches step 6 → returns 204.
    //   - Mapbox GL has no fallback parent in its OWN tile cache (cold
    //     pyramid) so it renders the requested tile as a flat plane at
    //     elevation 0 — exactly the "relief devient plat quand je zoom"
    //     symptom.
    //
    // Fix: serve AWS Terrarium (auto-clamps to its native z14) tagged with
    //   - X-DEM-Health: degraded → shouldSkipUnsafeOverzoomParent refuses
    //     to overzoom this for child tiles, so the coarse tile cannot
    //     poison child meshes (existing guard).
    //   - shortCache=true → 15 s TTL → next request retries the IGN
    //     pipeline, which by then is unsaturated and serves crisp LiDAR.
    //
    // Worst case the user sees ≤ 15 s of coarse 30 m terrain before the
    // pipeline self-upgrades to LiDAR HD. That is infinitely better than
    // a flat plane and avoids the visual "the relief disappeared" bug.
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

    // 6. Nothing worked — 204 with short TTL for transient failures, long for
    //    confirmed empty outside the supported LiDAR regions.
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
