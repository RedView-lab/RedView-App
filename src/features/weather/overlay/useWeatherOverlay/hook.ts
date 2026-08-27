import { useEffect, useMemo, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { clearWeatherOverlayCache } from '../client';
import type { WeatherOverlayMetric, WeatherOverlayState } from '../types';
import {
  createOverlayStatus,
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '@/features/map3d';
import type { RefreshReason } from './constants';
import {
  activeRenderableLayers,
  paletteSignature,
  selectionFromState,
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
  stateRef.current = state;

  const renderedRef = useRef<Partial<Record<WeatherOverlayMetric, RenderedLayerEntry>>>({});
  const isCancelledRef = useRef(false);
  const scheduleRefreshRef = useRef<((reason?: RefreshReason, isDebounced?: boolean) => void) | null>(null);

  const activeLayers = useMemo(() => activeRenderableLayers(state), [state]);

  const publishStatus = (status: ReturnType<typeof createOverlayStatus> | null) => {
    statusReporter?.(status);
  };

  const activeLayersKey = useMemo(
    () => activeLayers.map((layer) => `${layer.key}:${layer.mode}`).join('|'),
    [activeLayers],
  );
  const selectionKey = useMemo(() => selectionFromState(state).key, [state]);
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
    setLayerPaint,
    armStyleRecovery,
    completeStyleRecovery,
    clearStyleRecoveryTimers,
    hideAll,
    removeAll,
    ensureLayer,
  } = useWeatherStyleManager({
    map,
    stateRef,
    renderedRef,
    publishStatus,
    onRefreshRequest: (reason) => scheduleRefreshRef.current?.(reason),
    isCancelled: () => isCancelledRef.current,
  });

  const {
    renderFromData,
    scheduleRefresh,
    cancelPipeline,
    dataRef,
  } = useWeatherDataPipeline({
    map,
    stateRef,
    renderedRef,
    canMutateStyle,
    armStyleRecovery,
    completeStyleRecovery,
    hideAll,
    ensureLayer,
    publishStatus,
    isCancelled: () => isCancelledRef.current,
  });

  scheduleRefreshRef.current = scheduleRefresh;

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    isCancelledRef.current = false;

    if (!state.enabled || activeLayers.length === 0) {
      removeAll();
      return;
    }

    const onMoveEnd = () => scheduleRefresh('normal', true);
    const onStyleData = () => scheduleRefresh('force');

    map.on('moveend', onMoveEnd);
    map.on('styledata', onStyleData);

    scheduleRefresh('normal');

    return () => {
      isCancelledRef.current = true;
      map.off('moveend', onMoveEnd);
      map.off('styledata', onStyleData);
      cancelPipeline();
      clearStyleRecoveryTimers();
    };
  }, [map, isMapLoaded, state.enabled]);

  useEffect(() => {
    if (!state.enabled || activeLayers.length === 0) return;
    scheduleRefresh('normal');
  }, [selectionKey, activeLayersKey]);

  useEffect(() => {
    if (!state.enabled || activeLayers.length === 0) return;
    if (dataRef.current) {
      void renderFromData(dataRef.current);
    }
  }, [paletteKey]);

  useEffect(() => {
    if (!state.enabled || activeLayers.length === 0) return;
    for (const layer of activeLayers) {
      setLayerPaint(layer.key, layer.mode);
    }
  }, [opacityKey]);

  useEffect(() => {
    if (!registerReload) return;
    registerReload(() => {
      clearWeatherOverlayCache();
      dataRef.current = null;
      scheduleRefresh('reload');
    });
  }, [registerReload]);
}