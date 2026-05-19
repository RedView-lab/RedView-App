import type { MapSourceDataEvent } from 'mapbox-gl';
import { unifiedDEMSource, awsFallbackDEMSource, awsFastDEMSource } from '../../../lib/sources';
import { TerrainManager } from '../../../lib/terrain';
import { buildDemTilesTemplate } from '../demTiles';
import type { Ctx } from './context';
import { DEM_SETTILE_VERIFY_MS, STYLE_LOAD_WATCHDOG_MS } from './context';
import { getStyleContentStats } from './styleContent';
import { getActiveDem3dQuality } from '../../../lib/dem3dQualityBus';

/**
 * DEM source + terrain attachment lifecycle.
 *
 * Anti-flat reinforcements:
 *  - `refreshDemSource({ forceRebuild })` removes the source so the next
 *    `addSource` rebuilds the tile pyramid from scratch (the `setTiles`
 *    fast path leaves cached empty tiles in place).
 *  - `scheduleSetTilesVerify` re-checks ~3.5 s after a `setTiles`-only
 *    refresh that tiles actually started loading; if no DEM tile was
 *    requested OR terrain isn't bound, force a full rebuild.
 *  - `applyUnifiedTerrain` always re-issues `setTerrain` even if the
 *    manager already exists (covers the case where Mapbox silently
 *    detached terrain after a late style.load).
 */
export function attachDemSource(ctx: Ctx): void {
  const { map, terrainRef, isCancelled } = ctx;
  const fns = ctx.fns;
  const st = ctx.state;
  const terrainRecoveryRetryMs = 120;
  const maxTerrainRecoveryAttempts = Math.ceil((STYLE_LOAD_WATCHDOG_MS + 1000) / terrainRecoveryRetryMs);

  const canMutateTerrainStyle = (): boolean => {
    if (fns.canMutateStyle()) return true;
    try {
      const style = map.getStyle();
      const stats = getStyleContentStats(style);
      if (!stats.hasContent) return false;
      if (!st.spriteStormBypass) {
        // Use the canonical `[map3d] <origin>: style has content while
        // isStyleLoaded() is false — enabling sprite-storm bypass` log
        // format so satellite cold-start diagnostics stay consistent
        // with the styleBootstrap probe / styledata / idle / force-
        // bypass paths. Differentiating origin (`terrain-eager`) lets
        // us tell which code path won the race.
        console.warn(
          '[map3d] terrain-eager: style has content while isStyleLoaded() is false — enabling sprite-storm bypass',
          { layers: stats.layerCount, sources: stats.sourceCount, imports: stats.importCount },
        );
        st.spriteStormBypass = true;
      }
      return true;
    } catch {
      return false;
    }
  };

  fns.applyManagedTerrain = () => {
    // Fast 30 m mode short-circuits the unified-DEM pipeline. AWS
    // Terrarium is decoded natively on the GPU — no SW dependency,
    // no IGN — so any environment can switch to it instantly.
    if (getActiveDem3dQuality() === 'fast-30m') {
      return fns.applyFastDemTerrain();
    }
    if (map.getSource(unifiedDEMSource.id)) {
      return fns.applyUnifiedTerrain();
    }
    if (map.getSource(awsFallbackDEMSource.id)) {
      fns.attachAwsFallbackTerrain();
      return fns.isManagedTerrainActive();
    }
    return false;
  };

  fns.applyUnifiedTerrain = () => {
    // Honor the user's 3D quality choice: when fast-30m is active, every
    // caller (bootstrap, settle-verify, reload, idle handlers, …) must
    // route to the AWS fast source instead of re-binding the unified HD
    // DEM that we just swapped away from.
    if (getActiveDem3dQuality() === 'fast-30m') {
      return fns.applyFastDemTerrain();
    }
    if (!map.getSource(unifiedDEMSource.id)) return false;
    try {
      if (!terrainRef.current) {
        terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
      }
      // Idempotent: TerrainManager.init re-issues setTerrain. Doing this
      // unconditionally is the cheapest way to recover from a silent
      // detach (mapbox sometimes drops terrain after a late style.load
      // without firing any error).
      terrainRef.current.init();
      return true;
    } catch (error) {
      console.warn('[map3d] Unified terrain apply failed', error);
      return false;
    }
  };

  fns.detachManagedTerrain = () => {
    // Only tear down terrain when the active terrain source is one of the
    // managed DEM sources we own. Imported Mapbox Standard / Standard-
    // Satellite styles can temporarily publish their own builtin terrain
    // (`mapbox-dem`) during initial hydration; clearing that here before the
    // unified DEM bootstrap runs can suppress the whole readiness chain and
    // leave the globe permanently flat with zero `[map3d]` / `[sw-dem]`
    // activity. If our ref is stale but the active terrain is not managed,
    // drop the ref without mutating the style.
    let activeTerrainSource: string | null = null;
    try {
      activeTerrainSource = map.getTerrain()?.source ?? null;
    } catch {
      return;
    }
    const hasManagedTerrainActive = activeTerrainSource === unifiedDEMSource.id
      || activeTerrainSource === awsFallbackDEMSource.id
      || activeTerrainSource === awsFastDEMSource.id;
    if (!terrainRef.current && !hasManagedTerrainActive) return;

    if (terrainRef.current && hasManagedTerrainActive) {
      try {
        terrainRef.current.destroy();
      } catch {
        /* terrain teardown must stay best-effort during style rebuilds */
      }
    }
    terrainRef.current = null;
    if (!hasManagedTerrainActive) return;
    try {
      map.setTerrain(null);
    } catch {
      /* style may already be replacing the terrain graph */
    }
  };

  fns.refreshDemSource = (options: { forceRebuild?: boolean } = {}): boolean => {
    if (!canMutateTerrainStyle()) return false;
    if (!navigator.serviceWorker?.controller) {
      console.warn('[map3d] DEM source refresh skipped: no active service worker controller');
      return false;
    }

    st.disposeTerrainBootstrap?.();
    st.disposeTerrainBootstrap = null;
    if (st.setTilesVerifyTimer) {
      clearTimeout(st.setTilesVerifyTimer);
      st.setTilesVerifyTimer = null;
    }

    const tiles = buildDemTilesTemplate(st.demCacheBust, fns.getActiveDemProfile());
    const existingSource = map.getSource(unifiedDEMSource.id) as {
      setTiles?: (tiles: string[]) => unknown;
    } | undefined;

    if (existingSource && !options.forceRebuild) {
      if (typeof existingSource.setTiles !== 'function') {
        console.warn('[map3d] DEM source refresh skipped: source cannot update tiles');
        return false;
      }
      existingSource.setTiles(tiles);
      fns.refreshTrackedSourceIds();
      fns.applyUnifiedTerrain();
      // Anti-flat: a soft setTiles refresh keeps the existing tile
      // pyramid. Verify after a short delay that tiles actually started
      // loading and terrain is bound — otherwise upgrade to a full
      // rebuild.
      fns.scheduleSetTilesVerify();
      return true;
    }

    if (existingSource && options.forceRebuild) {
      // Full rebuild: detach managed terrain first so mapbox doesn't crash
      // when the raster-dem source disappears underneath the active terrain
      // graph, then drop the source so the next addSource refills the tile
      // pyramid from scratch (setTiles alone leaves cached empty tiles in
      // place, which is what keeps the map flat after a soft reload).
      fns.detachManagedTerrain();
      let removeSucceeded = false;
      try {
        map.removeSource(unifiedDEMSource.id);
        removeSucceeded = true;
      } catch (error) {
        console.warn('[map3d] DEM source remove failed (forceRebuild)', error);
        // Mapbox 3.x can crash in removeSource when the internal terrain
        // graph has a stale reference (Cannot read properties of undefined
        // reading 'get'). If the source still exists, fall back to a soft
        // setTiles refresh — better than crashing the whole bootstrap.
        const staleSource = map.getSource(unifiedDEMSource.id) as {
          setTiles?: (tiles: string[]) => unknown;
        } | undefined;
        if (staleSource && typeof staleSource.setTiles === 'function') {
          console.warn('[map3d] falling back to setTiles after failed removeSource');
          staleSource.setTiles(tiles);
          fns.refreshTrackedSourceIds();
          terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
          fns.applyUnifiedTerrain();
          fns.scheduleSetTilesVerify();
          return true;
        }
      }
      // If removeSource threw but the source is actually gone (race
      // condition), treat as a successful remove and fall through to
      // addSource below.
      if (!removeSucceeded && map.getSource(unifiedDEMSource.id)) {
        // Anti-flat: terrain was detached at the top of this branch and
        // the setTiles fallback above didn't fire (no setTiles method).
        // The source is still there — re-bind terrain to it before bailing
        // out so we never leave the map flat with a usable DEM source
        // sitting underneath.
        fns.applyUnifiedTerrain();
        return false;
      }
    }

    try {
      map.addSource(unifiedDEMSource.id, {
        type: 'raster-dem',
        tiles,
        tileSize: unifiedDEMSource.tileSize,
        encoding: unifiedDEMSource.encoding,
        minzoom: unifiedDEMSource.minzoom,
        maxzoom: unifiedDEMSource.maxzoom,
      });
    } catch (error) {
      console.warn('[map3d] DEM source attach failed', error);
      return false;
    }
    fns.refreshTrackedSourceIds();

    terrainRef.current = new TerrainManager(map, unifiedDEMSource.id);
    fns.applyUnifiedTerrain();
    return true;
  };

  fns.scheduleSetTilesVerify = () => {
    if (st.setTilesVerifyTimer) clearTimeout(st.setTilesVerifyTimer);
    st.setTilesVerifyTimer = setTimeout(() => {
      st.setTilesVerifyTimer = null;
      if (isCancelled()) return;
      if (getActiveDem3dQuality() === 'fast-30m') return;
      if (!canMutateTerrainStyle()) return;
      if (!map.getSource(unifiedDEMSource.id)) return;
      // If terrain isn't actually bound to unified-dem after setTiles,
      // force a clean rebuild — that's the symptom the user reports
      // ("la donnée semble là mais les tuiles ne se mettent pas en
      // relief").
      if (!fns.isUnifiedTerrainActive()) {
        console.warn('[map3d] setTiles verify: terrain not bound, forcing rebuild');
        fns.refreshDemSource({ forceRebuild: true });
        return;
      }
      // If no DEM tile loaded into the unified-dem source yet, the
      // previous tile pyramid is stale/empty — force rebuild to re-fetch
      // through the SW.
      let unifiedLoaded = false;
      try {
        unifiedLoaded = map.isSourceLoaded(unifiedDEMSource.id);
      } catch {
        unifiedLoaded = false;
      }
      const hasUnifiedTileActivity = [...st.requestedTiles, ...st.loadedTiles]
        .some((key) => key.startsWith(`${unifiedDEMSource.id}:`));
      if (!unifiedLoaded && !hasUnifiedTileActivity) {
        console.warn('[map3d] setTiles verify: no DEM tile activity, forcing rebuild');
        fns.refreshDemSource({ forceRebuild: true });
      }
    }, DEM_SETTILE_VERIFY_MS);
  };

  fns.scheduleTerrainRecovery = () => {
    if (st.terrainRecoveryTimer) return;
    // Small delay (instead of 0) lets Mapbox finish the styledata
    // burst that often precedes terrain detach — checking immediately
    // would race the rebuild.
    const runRecovery = (attempt: number) => {
      st.terrainRecoveryTimer = null;
      if (getActiveDem3dQuality() === 'fast-30m') {
        fns.applyFastDemTerrain();
        return;
      }
      const canRecoverDuringImportedStyleSettling = () => {
        try {
          const style = map.getStyle();
          const imports = (style as unknown as { imports?: Array<{ data?: unknown }> } | null)?.imports;
          const hasImportContent = Array.isArray(imports)
            && imports.some((imp) => imp && imp.data != null);
          const hasContent = style && (
            (style.layers?.length ?? 0) > 0
            || Object.keys(style.sources ?? {}).length > 0
            || hasImportContent
          );
          if (!hasContent) return false;
          if (!st.spriteStormBypass) {
            console.warn(
              '[map3d] terrain recovery: style has content while isStyleLoaded() is false — enabling sprite-storm bypass',
              {
                layers: style.layers?.length ?? 0,
                sources: Object.keys(style.sources ?? {}).length,
                imports: Array.isArray(imports) ? imports.length : 0,
              },
            );
            st.spriteStormBypass = true;
          }
          return true;
        } catch {
          return false;
        }
      };
      if (!fns.canMutateStyle() && !canRecoverDuringImportedStyleSettling()) {
        if (attempt >= maxTerrainRecoveryAttempts) return;
        st.terrainRecoveryTimer = setTimeout(() => {
          runRecovery(attempt + 1);
        }, terrainRecoveryRetryMs);
        return;
      }
      if (!navigator.serviceWorker?.controller) return;

      if (!map.getSource(unifiedDEMSource.id)) {
        if (!fns.refreshDemSource()) return;
        fns.reportStatus('loading', 68, 'Relief');
        fns.armTerrainBootstrap(() => {
          st.demTrackingEnabled = true;
          fns.scheduleDemSettle();
        });
        return;
      }

      fns.refreshTrackedSourceIds();
      if (!fns.isManagedTerrainActive()) {
        fns.applyUnifiedTerrain();
        // If re-attach didn't take, the source is probably stale. Force
        // a rebuild rather than leaving the map flat.
        if (!fns.isManagedTerrainActive()) {
          console.warn('[map3d] terrain re-attach failed; forcing source rebuild');
          fns.refreshDemSource({ forceRebuild: true });
        }
      }
    };

    st.terrainRecoveryTimer = setTimeout(() => {
      runRecovery(0);
    }, 60);
  };

  fns.armTerrainBootstrap = (onReady: () => void) => {
    st.disposeTerrainBootstrap?.();

    let applied = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const complete = () => {
      if (applied) return;
      applied = true;
      map.off('sourcedata', onSourceData);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      st.disposeTerrainBootstrap = null;
      fns.applyUnifiedTerrain();
      fns.reportStatus('loading', 82, 'Terrain');
      onReady();
    };
    const onSourceData = (event: MapSourceDataEvent) => {
      if (applied) return;
      if (event.sourceId !== unifiedDEMSource.id) return;
      if (!event.isSourceLoaded) return;
      complete();
    };

    st.disposeTerrainBootstrap = () => {
      map.off('sourcedata', onSourceData);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };

    fns.applyUnifiedTerrain();
    map.on('sourcedata', onSourceData);

    if (map.isSourceLoaded(unifiedDEMSource.id)) {
      onSourceData({ sourceId: unifiedDEMSource.id, isSourceLoaded: true } as MapSourceDataEvent);
    } else {
      fallbackTimer = setTimeout(complete, 1200);
    }
  };

  // ── AWS Terrarium direct fallback ──────────────────────────────────
  // Used when the SW never claims. Attaches AWS Open Data Terrarium
  // tiles directly as a raster-dem source with native `terrarium`
  // encoding. Mapbox GL v3 handles the decode on the GPU — no SW
  // pipeline, no re-encoding, no overzoom logic. ~30 m global terrain.
  fns.attachAwsFallbackTerrain = () => {
    if (!canMutateTerrainStyle()) return;
    // Honor user's 3D quality choice: in fast-30m mode the fast source
    // owns the terrain binding; don't let the fallback path override it.
    if (getActiveDem3dQuality() === 'fast-30m') {
      fns.applyFastDemTerrain();
      return;
    }
    // Don't attach if the unified-dem source is already present
    // (SW path took over).
    if (map.getSource(unifiedDEMSource.id)) return;
    const sourceAlreadyPresent = !!map.getSource(awsFallbackDEMSource.id);

    if (!sourceAlreadyPresent) {
      try {
        map.addSource(awsFallbackDEMSource.id, {
          type: 'raster-dem',
          tiles: awsFallbackDEMSource.tiles,
          tileSize: awsFallbackDEMSource.tileSize,
          encoding: awsFallbackDEMSource.encoding,
          minzoom: awsFallbackDEMSource.minzoom,
          maxzoom: awsFallbackDEMSource.maxzoom,
        });
      } catch (error) {
        console.warn('[map3d] AWS fallback DEM source attach failed', error);
        return;
      }
    }

    try {
      terrainRef.current = new TerrainManager(map, awsFallbackDEMSource.id);
      terrainRef.current.init();
      console.log(
        sourceAlreadyPresent
          ? '[map3d] AWS Terrarium fallback terrain re-attached'
          : '[map3d] AWS Terrarium fallback terrain attached',
      );
    } catch (error) {
      console.warn('[map3d] AWS fallback terrain apply failed', error);
    }
  };

  fns.detachAwsFallbackTerrain = () => {
    let hasAwsSource = false;
    let activeTerrainSource: string | null = null;
    try {
      hasAwsSource = !!map.getSource(awsFallbackDEMSource.id);
    } catch { /* best-effort */ }
    try {
      activeTerrainSource = map.getTerrain()?.source ?? null;
    } catch { /* best-effort */ }

    if (!hasAwsSource && activeTerrainSource !== awsFallbackDEMSource.id) return;

    if (activeTerrainSource === awsFallbackDEMSource.id) {
      try {
        terrainRef.current?.destroy();
      } catch { /* best-effort */ }
      terrainRef.current = null;
      try {
        map.setTerrain(null);
      } catch { /* best-effort */ }
    }

    try {
      if (hasAwsSource) {
        map.removeSource(awsFallbackDEMSource.id);
        console.log('[map3d] AWS fallback DEM source removed');
      }
    } catch (error) {
      console.warn('[map3d] AWS fallback DEM source remove failed', error);
    }
  };

  // ── Fast 30 m mode (AWS Terrarium direct, no SW) ──────────────────
  // Identical AWS Open Data Terrarium pipeline as the fallback but
  // attached under its own source id `aws-fast-dem` so it can coexist
  // with the unified SW source without conflict — letting us swap back
  // and forth between HD and Fast quality instantly. The browser HTTP
  // cache + Mapbox per-source tile cache make every subsequent swap
  // free of any visible lag.
  fns.applyFastDemTerrain = () => {
    if (!canMutateTerrainStyle()) return false;
    const sourceAlreadyPresent = !!map.getSource(awsFastDEMSource.id);
    if (!sourceAlreadyPresent) {
      try {
        map.addSource(awsFastDEMSource.id, {
          type: 'raster-dem',
          tiles: awsFastDEMSource.tiles,
          tileSize: awsFastDEMSource.tileSize,
          encoding: awsFastDEMSource.encoding,
          minzoom: awsFastDEMSource.minzoom,
          maxzoom: awsFastDEMSource.maxzoom,
        });
      } catch (error) {
        console.warn('[map3d] AWS fast DEM source attach failed', error);
        return false;
      }
    }

    try {
      // Replace any existing TerrainManager binding (which may target
      // unified-dem or aws-fallback-dem) with a fresh one pointing at
      // the fast source. TerrainManager.init() issues setTerrain which
      // Mapbox treats as a hot-swap — no flat frame in between.
      let activeTerrainSource: string | null = null;
      try { activeTerrainSource = map.getTerrain()?.source ?? null; } catch { /* best-effort */ }
      const alreadyBound = activeTerrainSource === awsFastDEMSource.id;
      if (alreadyBound && terrainRef.current) {
        // Idempotent re-call — just ensure setTerrain is re-issued in
        // case Mapbox silently detached it.
        terrainRef.current.init();
        return true;
      }
      if (terrainRef.current) {
        try { terrainRef.current.destroy(); } catch { /* best-effort */ }
      }
      terrainRef.current = new TerrainManager(map, awsFastDEMSource.id);
      terrainRef.current.init();
      console.log(
        sourceAlreadyPresent
          ? '[map3d] fast 30 m terrain re-bound'
          : '[map3d] fast 30 m terrain attached',
      );
      return true;
    } catch (error) {
      console.warn('[map3d] fast 30 m terrain apply failed', error);
      return false;
    }
  };

  // Quality switch entry point. Idempotent — safe to call repeatedly
  // with the same value (no-ops if the desired terrain is already
  // bound). Designed for zero-flicker user-facing toggling.
  fns.setDem3dQuality = (quality) => {
    if (quality === 'fast-30m') {
      fns.applyFastDemTerrain();
      return;
    }
    // 'hd' → return to the unified SW pipeline. Don't tear down the
    // fast source — keep it resident so the next switch back is
    // also instant.
    if (map.getSource(unifiedDEMSource.id)) {
      // Re-bind TerrainManager to the unified source.
      try {
        if (terrainRef.current) {
          try { terrainRef.current.destroy(); } catch { /* best-effort */ }
          terrainRef.current = null;
        }
      } catch { /* best-effort */ }
      fns.applyUnifiedTerrain();
      console.log('[map3d] HD terrain re-bound (unified DEM)');
      return;
    }
    // Unified source missing — fall back to AWS fallback (or, if even
    // that's missing, leave the fast source bound rather than going
    // flat). The bootstrap will eventually attach unified-dem.
    if (map.getSource(awsFallbackDEMSource.id)) {
      try {
        if (terrainRef.current) {
          try { terrainRef.current.destroy(); } catch { /* best-effort */ }
          terrainRef.current = null;
        }
      } catch { /* best-effort */ }
      fns.attachAwsFallbackTerrain();
      console.log('[map3d] HD terrain unavailable — bound to AWS fallback while bootstrap runs');
    }
    // Else: nothing to do; bootstrap will route via applyManagedTerrain.
  };
}
