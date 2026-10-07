import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { clearWeatherMetaCache } from '../vpsWeatherClient';
import { clearRecoloredBlobCache } from '../vpsTileRenderer';
import type { WeatherOverlayMetric, WeatherOverlayState } from '../types';
import {
  createOverlayStatus,
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '@/features/map3d';
import type { RefreshReason } from './constants';
import { SUPPORTED_KEYS } from './constants';
import {
  activeRenderableLayers,
  paletteSignature,
  weatherSelectionKey,
  type RenderedLayerEntry,
} from './helpers';
import { useWeatherStyleManager } from './useWeatherStyleManager';
import { useWeatherDataPipeline } from './useWeatherDataPipeline';

/**
 * Hook gérant l'overlay météorologique Mapbox (vent, rafales, pluie, température, etc.)
 * avec pipeline de requêtes interpolées, mise en cache et synchronisation de style Mapbox.
 */
export function useWeatherOverlay(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  state: WeatherOverlayState,
  options: {
    statusReporter?: OverlayStatusReporter;
    registerReload?: OverlayReloadRegistrar;
  } = {},
): void {
  const { statusReporter, registerReload } = options;
  const stateRef = useRef(state);

  const renderedRef = useRef<Partial<Record<WeatherOverlayMetric, RenderedLayerEntry>>>({});
  const isCancelledRef = useRef(false);
  const scheduleRefreshRef = useRef<((reason?: RefreshReason, isDebounced?: boolean) => void) | null>(null);

  const activeLayers = useMemo(() => activeRenderableLayers(state), [state]);
  const activeLayersRef = useRef(activeLayers);
  // Valeurs commitées pour les callbacks Mapbox et les effets (avant eux : layout).
  useLayoutEffect(() => {
    stateRef.current = state;
    activeLayersRef.current = activeLayers;
  }, [state, activeLayers]);

  const publishStatus = (status: ReturnType<typeof createOverlayStatus> | null) => {
    statusReporter?.(status);
  };

  const activeLayersKey = useMemo(
    () => activeLayers.map((layer) => `${layer.key}:${layer.mode}`).join('|'),
    [activeLayers],
  );
  const selectionKey = useMemo(() => weatherSelectionKey(state), [state]);
  const paletteKey = useMemo(
    () => activeLayers
      .map((layer) => `${layer.key}:${paletteSignature(state, layer.key)}`)
      .join('|'),
    [activeLayers, state],
  );
  const opacityKey = useMemo(
    () => activeLayers
      .map((layer) => `${layer.key}:${state.palettes?.[layer.key]?.opacity ?? 100}`)
      .join('|'),
    [activeLayers, state],
  );

  const {
    canMutateStyle,
    setVisibility,
    setLayerPaint,
    setRadarVisibility,
    ensureRadarLayer,
    armStyleRecovery,
    completeStyleRecovery,
    clearStyleRecoveryTimers,
    hideAll,
    removeAll,
    ensureLayer,
    hideLayerCompletely,
    hideRadarCompletely,
    drainPendingHiddenLayers,
  } = useWeatherStyleManager({
    map,
    stateRef,
    renderedRef,
    publishStatus,
    onRefreshRequest: (reason) => scheduleRefreshRef.current?.(reason),
    isCancelled: () => isCancelledRef.current,
  });

  const {
    scheduleRefresh,
    cancelPipeline,
  } = useWeatherDataPipeline({
    map,
    stateRef,
    renderedRef,
    canMutateStyle,
    armStyleRecovery,
    completeStyleRecovery,
    clearStyleRecoveryTimers,
    hideAll,
    hideLayerCompletely,
    hideRadarCompletely,
    setVisibility,
    ensureLayer,
    ensureRadarLayer,
    setRadarVisibility,
    publishStatus,
    isCancelled: () => isCancelledRef.current,
  });

  useLayoutEffect(() => {
    scheduleRefreshRef.current = scheduleRefresh;
  }, [scheduleRefresh]);

  // 1. Map Lifecycle & Mapbox Event Listeners (strictly [map, isMapLoaded])
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    isCancelledRef.current = false;

    const onMoveEnd = () => {
      if (!stateRef.current.enabled || activeLayersRef.current.length === 0) {
        hideAll();
        return;
      }
      scheduleRefresh('normal', true);
    };

    const onStyleData = () => {
      if (!map || isCancelledRef.current) return;
      drainPendingHiddenLayers();

      const currentActive = activeLayersRef.current;
      if (!stateRef.current.enabled || currentActive.length === 0) {
        hideAll();
        return;
      }

      if (!canMutateStyle()) return;

      // Re-apply already rendered layers if map style stripped them (e.g. during basemap transition)
      const rendered = renderedRef.current;
      let hasMissingLayer = false;
      for (const layer of currentActive) {
        const item = rendered[layer.key];
        if (item) {
          ensureLayer(layer.key, layer.mode, item.url, item.coords);
        } else {
          hasMissingLayer = true;
        }
      }

      // Ensure any layer NOT in currentActive is guaranteed hidden
      for (const key of SUPPORTED_KEYS) {
        if (!currentActive.some((l) => l.key === key)) {
          hideLayerCompletely(key);
        }
      }

      if (hasMissingLayer) {
        scheduleRefresh('normal', 'move');
      }
    };

    const onIdle = () => {
      if (!map || isCancelledRef.current) return;
      drainPendingHiddenLayers();
    };

    map.on('moveend', onMoveEnd);
    map.on('styledata', onStyleData);
    map.on('idle', onIdle);

    return () => {
      isCancelledRef.current = true;
      map.off('moveend', onMoveEnd);
      map.off('styledata', onStyleData);
      map.off('idle', onIdle);
      cancelPipeline();
      clearStyleRecoveryTimers();
      removeAll();
    };
  }, [map, isMapLoaded]);

  const prevStateRef = useRef({
    selectionKey,
    activeLayersKey,
    paletteKey,
    enabled: state.enabled,
  });
  const isMountedRef = useRef(false);

  // 2. State Coordinator: Reacts to layer toggles, time scrubbing, and palette changes
  useEffect(() => {
    if (!map || !isMapLoaded) return;

    if (!state.enabled || activeLayers.length === 0) {
      cancelPipeline();
      clearStyleRecoveryTimers();
      hideAll();
      prevStateRef.current = { selectionKey, activeLayersKey, paletteKey, enabled: state.enabled };
      return;
    }

    // Immediately hide any layers that are no longer active
    for (const key of SUPPORTED_KEYS) {
      if (!activeLayers.some((layer) => layer.key === key)) {
        hideLayerCompletely(key);
      }
    }

    if (!isMountedRef.current) {
      isMountedRef.current = true;
      prevStateRef.current = { selectionKey, activeLayersKey, paletteKey, enabled: state.enabled };
      scheduleRefresh('normal', false);
      return;
    }

    const prev = prevStateRef.current;
    const isSelectionChanged = prev.selectionKey !== selectionKey;
    const isLayersChanged = prev.activeLayersKey !== activeLayersKey;
    const isPaletteChanged = prev.paletteKey !== paletteKey;
    const isEnabledChanged = prev.enabled !== state.enabled;

    prevStateRef.current = { selectionKey, activeLayersKey, paletteKey, enabled: state.enabled };

    // Case 1: Palette change (color, band breakpoints, scale) -> Instant recolor (delay = 0, no debounce)
    if (isPaletteChanged && !isSelectionChanged && !isLayersChanged && !isEnabledChanged) {
      scheduleRefresh('force', false);
      return;
    }

    // Case 2: Layer toggle on/off or render mode change -> Instant display (delay = 0)
    if (isLayersChanged || isEnabledChanged) {
      scheduleRefresh('normal', false);
      return;
    }

    // Case 3: Time scrubbing / date change -> Fast 60ms debounce for rapid drag responsiveness
    if (isSelectionChanged) {
      scheduleRefresh('normal', 'scrub');
    }
  }, [map, isMapLoaded, selectionKey, activeLayersKey, paletteKey, state.enabled]);

  useEffect(() => {
    if (!state.enabled || activeLayers.length === 0) return;
    for (const layer of activeLayers) {
      setLayerPaint(layer.key, layer.mode);
    }
  }, [opacityKey]);

  useEffect(() => {
    if (!registerReload) return;
    registerReload(() => {
      clearWeatherMetaCache();
      clearRecoloredBlobCache();
      scheduleRefresh('reload');
    });
  }, [registerReload]);
}