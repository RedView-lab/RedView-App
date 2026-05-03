import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap, MapSourceDataEvent } from 'mapbox-gl';
import type { SlopeColorMode, SlopeCategory } from '../types';
import {
  SLOPE_SOURCE_ID,
  SLOPE_LAYER_ID,
  type SlopeTileSourceOptions,
  buildSlopeSourceKey,
  buildSlopeTileSource,
  buildSlopeLayer,
  buildSlopeColorExpression,
} from '../lib/slope-source';
import {
  createOverlayStatus,
  type OverlayStatusReporter,
} from '@/features/map3d';

// ── DevTools helper: clear slope cache ────────────────────────────────
// Usage: window.__clearSlopeCache() in DevTools, then reload the map.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__clearSlopeCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_SLOPE_CACHE' });
    // eslint-disable-next-line no-console
    console.log('[slope][debug] CLEAR_SLOPE_CACHE sent — reload to fetch fresh tiles.');
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function hiddenIdsFromRanges(
  hiddenRanges: ReadonlyArray<readonly [number, number]> | undefined,
  categories: SlopeCategory[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!hiddenRanges?.length || !categories?.length) return out;
  for (const cat of categories) {
    for (const [a, b] of hiddenRanges) {
      // Match by exact band range — the panel hides whole categories.
      if (cat.minDeg === a && cat.maxDeg === b) {
        out.add(cat.id);
        break;
      }
    }
  }
  return out;
}

// Idempotent: ensures BOTH source and layer exist. Safe to call multiple
// times — will only add what's missing.
function addSlopeLayer(
  map: MapboxMap,
  opacity: number,
  colorMode: SlopeColorMode,
  categories: SlopeCategory[],
  hiddenIds: Set<string>,
  sourceOptions: SlopeTileSourceOptions,
) {
  try {
    if (!map.getSource(SLOPE_SOURCE_ID)) {
      map.addSource(SLOPE_SOURCE_ID, buildSlopeTileSource(sourceOptions));
    }
    if (!map.getLayer(SLOPE_LAYER_ID)) {
      const layer = buildSlopeLayer(opacity, colorMode, categories, hiddenIds);
      map.addLayer(layer as Parameters<MapboxMap['addLayer']>[0]);
    }
  } catch {
    /* style may be transitioning — safe to ignore */
  }
}

function removeSlopeLayer(map: MapboxMap) {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) map.removeLayer(SLOPE_LAYER_ID);
    if (map.getSource(SLOPE_SOURCE_ID)) map.removeSource(SLOPE_SOURCE_ID);
  } catch {
    /* style may be transitioning — safe to ignore */
  }
}

// Instant visibility flip — one shader uniform, no tile refetch, no PNG
// pipeline round-trip. This is what makes the toggle feel snappy on rapid
// on/off clicks: source + textures stay alive in Mapbox; we just hide them.
function setSlopeVisibility(map: MapboxMap, visible: boolean) {
  try {
    if (map.getLayer(SLOPE_LAYER_ID)) {
      map.setLayoutProperty(
        SLOPE_LAYER_ID,
        'visibility',
        visible ? 'visible' : 'none',
      );
    }
  } catch {
    /* layer may not exist yet */
  }
}

// ── Hook ──────────────────────────────────────────────────────────────
//
// Update model — designed for instant UX on rapid toggling:
//
//   ┌──────────────────────────┬────────────────────────────────────────┐
//   │ Change                    │ Action                                 │
//   ├──────────────────────────┼────────────────────────────────────────┤
//   │ enabled toggle (1st on)   │ add source + layer                     │
//   │ enabled toggle (later)    │ setLayoutProperty('visibility')        │
//   │                           │   ↳ NO source rebuild, NO tile refetch │
//   │ opacity                   │ setPaintProperty('raster-opacity')      │
//   │ colorMode / categories /  │ setPaintProperty('raster-color')        │
//   │   hidden bands            │                                         │
//   │ resolution                │ rebuild source (real data change)       │
//   │ style.load                │ re-add layer with current state         │
//   │ unmount                   │ remove layer + source                   │
//   └──────────────────────────┴────────────────────────────────────────┘
//
// Why visibility instead of remove+readd on every toggle?
//   • Removing the source aborts in-flight tile requests and forces Mapbox
//     to refetch every visible tile on re-add. With a slow SW slope
//     pipeline (DEM decode → Horn → PNG encode), this caused multi-second
//     reappearance after a quick toggle and occasional "doesn't appear"
//     races between teardown and re-add.
//   • Visibility=none is a single layout-property change. Tiles stay in
//     the GPU texture cache, so toggling back is instant (≤1 frame).
//   • Mapbox stops sampling/uploading tiles for invisible raster layers,
//     so there's no rendering cost while disabled.

export function useSlope(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  opacity: number,
  colorMode: SlopeColorMode,
  hiddenRanges?: ReadonlyArray<readonly [number, number]>,
  categories?: SlopeCategory[],
  sourceOptions: SlopeTileSourceOptions = { demProfile: 'default', resolutionFactor: 1 },
  onLoadStatusChange?: OverlayStatusReporter,
) {
  // Memoise the hidden-ids set so dependent effects compare a stable value.
  const hiddenIds = useMemo(
    () => hiddenIdsFromRanges(hiddenRanges, categories),
    [hiddenRanges, categories],
  );

  // Stable hash of category breakpoints + colors so we only rebuild paint
  // when something actually changes (not on every parent re-render).
  const categoriesKey = useMemo(
    () => (categories ?? []).map((c) => `${c.id}:${c.minDeg}-${c.maxDeg}:${c.color}`).join('|'),
    [categories],
  );

  // Stable hash of hidden ids.
  const hiddenKey = useMemo(
    () => Array.from(hiddenIds).sort().join(','),
    [hiddenIds],
  );
  const sourceKey = useMemo(() => buildSlopeSourceKey(sourceOptions), [sourceOptions]);

  // Refs for values needed inside style.load / mount callbacks.
  const opacityRef = useRef(opacity);
  const colorModeRef = useRef(colorMode);
  const enabledRef = useRef(enabled);
  const categoriesRef = useRef(categories);
  const hiddenIdsRef = useRef(hiddenIds);
  const sourceOptionsRef = useRef(sourceOptions);
  opacityRef.current = opacity;
  colorModeRef.current = colorMode;
  enabledRef.current = enabled;
  categoriesRef.current = categories;
  hiddenIdsRef.current = hiddenIds;
  sourceOptionsRef.current = sourceOptions;

  // Tracks whether the source+layer are currently mounted in the map.
  // Reset to false whenever the style is reloaded (Mapbox wipes custom
  // sources/layers on style swap). NOT in sync with `enabled` — we keep
  // the layer mounted across enable/disable toggles and use visibility.
  const mountedRef = useRef(false);
  // Last source key we mounted with — used to detect real data-affecting
  // changes (DEM profile / sampling factor).
  const mountedSourceKeyRef = useRef<string | null>(null);

  // ── 1. Mount layer on first enable (idempotent) ──────────────────────
  // We add the layer the first time the user enables slope. After that,
  // disable/re-enable cycles only flip visibility (effect 2) — the source
  // stays mounted so tiles stay in GPU cache and the toggle is instant.
  useEffect(() => {
    if (!map || !isMapLoaded || !enabled) return;
    if (mountedRef.current) return;
    addSlopeLayer(
      map,
      opacityRef.current,
      colorModeRef.current,
      categoriesRef.current ?? [],
      hiddenIdsRef.current,
      sourceOptionsRef.current,
    );
    mountedRef.current = true;
    mountedSourceKeyRef.current = buildSlopeSourceKey(sourceOptionsRef.current);
  }, [map, isMapLoaded, enabled]);

  // ── 1b. Rebuild source on DEM-profile / sampling change ───────────────
  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    if (mountedSourceKeyRef.current === sourceKey) return;
    removeSlopeLayer(map);
    mountedRef.current = false;
    addSlopeLayer(
      map,
      opacityRef.current,
      colorModeRef.current,
      categoriesRef.current ?? [],
      hiddenIdsRef.current,
      sourceOptions,
    );
    mountedRef.current = true;
    mountedSourceKeyRef.current = sourceKey;
    // Re-apply visibility in case the layer is currently disabled.
    setSlopeVisibility(map, enabledRef.current);
  }, [map, isMapLoaded, sourceKey, sourceOptions]);

  // ── 2. Visibility flip → instant on rapid toggles ────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    setSlopeVisibility(map, enabled);
  }, [map, isMapLoaded, enabled]);

  // ── 3. Opacity → instant ─────────────────────────────────────────────
  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        map.setPaintProperty(SLOPE_LAYER_ID, 'raster-opacity', opacity);
      }
    } catch {
      /* layer may not exist yet */
    }
  }, [map, isMapLoaded, opacity]);

  // ── 4. Color expression (mode / categories / hidden) → instant ───────
  // No source rebuild, no tile refetch. Mapbox swaps the GPU shader uniform
  // and the next frame already shows the new colors.
  useEffect(() => {
    if (!map || !isMapLoaded || !mountedRef.current) return;
    if (!categories?.length) return;
    try {
      if (map.getLayer(SLOPE_LAYER_ID)) {
        const expr = buildSlopeColorExpression(categories, colorMode, hiddenIds);
        // Mapbox typings expose ExpressionSpecification as a tuple union; the
        // dynamically-built expression is structurally valid but TS can't
        // narrow it, so we widen via `unknown` here.
        map.setPaintProperty(
          SLOPE_LAYER_ID,
          'raster-color',
          expr as unknown as string,
        );
      }
    } catch {
      /* layer may not exist yet */
    }
    // categoriesKey + hiddenKey provide stable dependency identity;
    // colorMode is a primitive.
  }, [map, isMapLoaded, colorMode, categoriesKey, hiddenKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 5. Style reload: re-add the layer with current state ─────────────
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      // Style swap wipes all custom sources/layers — reset our mount flag.
      mountedRef.current = false;
      mountedSourceKeyRef.current = null;
      // Defer to the next tick so style.load completes before we touch it.
      setTimeout(() => {
        if (!enabledRef.current) return;
        addSlopeLayer(
          map,
          opacityRef.current,
          colorModeRef.current,
          categoriesRef.current ?? [],
          hiddenIdsRef.current,
          sourceOptionsRef.current,
        );
        mountedRef.current = true;
        mountedSourceKeyRef.current = buildSlopeSourceKey(sourceOptionsRef.current);
      }, 0);
    };

    map.on('style.load', onStyleLoad);
    return () => { map.off('style.load', onStyleLoad); };
  }, [map, isMapLoaded]);

  // ── 6. Unmount: actual teardown ──────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    return () => {
      try {
        if (map.getStyle && map.getStyle()) removeSlopeLayer(map);
      } catch {
        /* map already destroyed */
      }
      mountedRef.current = false;
    };
  }, [map]);

  // ── 7. Tile load progress reporter ───────────────────────────────────
  // Tracks slope tile fetches at the source level (`sourcedataloading` ↔
  // `sourcedata`) so the user sees a real "Pentes XX%" pill while the SW
  // pipeline (DEM decode → Horn → PNG encode) processes tiles. Without
  // this reporter the slope toggle silently appeared to do nothing for
  // several seconds on first activation.
  const onLoadStatusChangeRef = useRef(onLoadStatusChange);
  onLoadStatusChangeRef.current = onLoadStatusChange;
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const reporter = onLoadStatusChangeRef.current;
    if (!reporter) return;
    if (!enabled) {
      reporter(null);
      return;
    }

    const requested = new Set<string>();
    const loaded = new Set<string>();
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let lastEmittedProgress = -1;
    let lastEmittedState: 'loading' | 'ready' = 'loading';

    const tileKey = (event: MapSourceDataEvent): string | null => {
      const tileID = (event as unknown as { tile?: { tileID?: { canonical?: { z: number; x: number; y: number } } } })
        .tile?.tileID?.canonical;
      if (!tileID) return null;
      return `${tileID.z}/${tileID.x}/${tileID.y}`;
    };

    const isSlopeEvent = (event: MapSourceDataEvent): boolean => (
      event.sourceId === SLOPE_SOURCE_ID
    );

    const emit = (state: 'loading' | 'ready', progress: number, detail?: string) => {
      if (state === lastEmittedState && progress === lastEmittedProgress) return;
      lastEmittedState = state;
      lastEmittedProgress = progress;
      onLoadStatusChangeRef.current?.(createOverlayStatus({
        id: 'slope',
        label: 'Pentes',
        state,
        progress,
        detail,
      }));
    };

    const publishProgress = () => {
      const total = requested.size;
      const done = loaded.size;
      if (total === 0) {
        emit('loading', 5, 'En attente de tuiles');
        return;
      }
      if (done >= total) {
        emit('ready', 100, 'Pentes prêtes');
        return;
      }
      const ratio = done / Math.max(total, 1);
      const pct = Math.max(1, Math.min(99, Math.round(ratio * 100)));
      emit('loading', pct, `Tuiles ${done}/${total}`);
    };

    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      // The slope SW pipeline can be slow on first cold viewport (many
      // composites + Horn + encode). The watchdog only force-completes
      // if the same totals stick for 12s — long enough not to lie about
      // progress, short enough to recover from a stuck state.
      watchdog = setTimeout(() => {
        watchdog = null;
        if (loaded.size >= requested.size && requested.size > 0) {
          emit('ready', 100, 'Pentes prêtes');
        }
      }, 12000);
    };

    const scheduleSettle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        publishProgress();
      }, 120);
    };

    const onLoading = (event: MapSourceDataEvent) => {
      if (!isSlopeEvent(event)) return;
      const key = tileKey(event);
      if (!key) return;
      requested.add(key);
      scheduleSettle();
      armWatchdog();
    };

    const onLoaded = (event: MapSourceDataEvent) => {
      if (!isSlopeEvent(event)) return;
      const key = tileKey(event);
      if (key) {
        requested.add(key);
        loaded.add(key);
      }
      if (event.isSourceLoaded) {
        // Mapbox signals the source is fully loaded — flush as ready.
        scheduleSettle();
      } else {
        scheduleSettle();
      }
    };

    const onError = (event: MapSourceDataEvent) => {
      if (!isSlopeEvent(event)) return;
      const key = tileKey(event);
      if (key) {
        // Drop from requested so we don't get stuck at <100%.
        requested.delete(key);
        loaded.delete(key);
      }
      scheduleSettle();
    };

    map.on('sourcedataloading', onLoading);
    map.on('sourcedata', onLoaded);
    map.on('dataabort', onError);

    // Seed initial state so the user sees a pill immediately on enable.
    emit('loading', 5, 'Préparation des pentes');
    armWatchdog();

    return () => {
      map.off('sourcedataloading', onLoading);
      map.off('sourcedata', onLoaded);
      map.off('dataabort', onError);
      if (settleTimer) clearTimeout(settleTimer);
      if (watchdog) clearTimeout(watchdog);
      onLoadStatusChangeRef.current?.(null);
    };
  }, [map, isMapLoaded, enabled]);
}