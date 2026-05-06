import { useEffect, useMemo, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';
import {
  buildWeatherGrid,
  clearWeatherOverlayCache,
  fetchWeatherGridData,
  weatherDataSelectionKey,
  weatherGridSupportsViewport,
} from '../client';
import { renderWeatherCanvas } from '../render';
import { getOverlayRenderSize } from '../renderSize';
import type {
  WeatherGridDataset,
  WeatherOverlayMetric,
  WeatherOverlayMode,
  WeatherOverlayState,
} from '../types';
import {
  createOverlayStatus,
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '@/features/map3d';
import {
  MIN_FETCH_INTERVAL_MS,
  MOVE_DEBOUNCE_MS,
  STATUS_ID,
  STYLE_SYNC_MAX_POLLS,
  STYLE_SYNC_POLL_MS,
  STYLE_SYNC_RETRY_MS,
  STYLE_SYNC_WATCHDOG_MS,
  SUPPORTED_KEYS,
  type RefreshReason,
  layerId,
  sourceId,
} from './constants';
import {
  activeRenderableLayers,
  canvasToObjectUrl,
  containsBounds,
  coordsEqual,
  getViewportBounds,
  imageCoords,
  logWeatherOverlay,
  paletteOpacity,
  paletteSignature,
  preload,
  readStyleHealth,
  selectionFromState,
  styleSyncProgress,
  type RenderedLayerEntry,
  type ViewportBounds,
} from './helpers';

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

  const dataRef = useRef<WeatherGridDataset | null>(null);
  const lastViewportRef = useRef<ViewportBounds | null>(null);
  const lastFetchTimeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const styleRetryRef = useRef<number | null>(null);
  const styleWatchdogRef = useRef<number | null>(null);
  const stylePollRef = useRef<number | null>(null);
  const styleFallbackUsableRef = useRef(false);
  const stylePollCountRef = useRef(0);
  const lastStyleBlockLogAtRef = useRef(0);
  const generationRef = useRef(0);
  const scheduleRefreshRef = useRef<((reason: RefreshReason) => void) | null>(null);
  const hideAllRef = useRef<(() => void) | null>(null);
  const renderedRef = useRef<Partial<Record<WeatherOverlayMetric, RenderedLayerEntry>>>({});
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

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let cancelled = false;

    const clearStyleRecoveryTimers = () => {
      if (styleRetryRef.current != null) {
        window.clearTimeout(styleRetryRef.current);
        styleRetryRef.current = null;
      }
      if (styleWatchdogRef.current != null) {
        window.clearTimeout(styleWatchdogRef.current);
        styleWatchdogRef.current = null;
      }
      if (stylePollRef.current != null) {
        window.clearInterval(stylePollRef.current);
        stylePollRef.current = null;
      }
      stylePollCountRef.current = 0;
    };

    const canMutateStyle = () => {
      if (cancelled) return false;
      try {
        if (styleFallbackUsableRef.current) {
          const style = map.getStyle();
          return Boolean(style) && Object.keys(style.sources ?? {}).length > 0;
        }
        if (map.isStyleLoaded() && Boolean(map.getStyle())) return true;
        // Eager fallback promotion: the strict `isStyleLoaded()` flag flips
        // back to false on EVERY `styledata` event (DEM/slope/altitude tile
        // arrivals, ortho crossfade, terrain attach, etc.), so during a
        // heavy load it can be `false` for many seconds at a stretch. As
        // long as the style HAS sources we're safe to add an image source
        // + raster layer — Mapbox accepts mutations on a non-fully-idle
        // style without throwing. Promote the fallback inline so the
        // weather pipeline never waits on the watchdog.
        if (promoteStyleFallbackIfUsable('canMutateStyle-eager')) {
          const style = map.getStyle();
          return Boolean(style) && Object.keys(style.sources ?? {}).length > 0;
        }
        return false;
      } catch {
        return false;
      }
    };

    const styleRecoveryActive = () => (
      styleRetryRef.current != null
      || styleWatchdogRef.current != null
      || stylePollRef.current != null
    );

    const promoteStyleFallbackIfUsable = (trigger: string): boolean => {
      if (styleFallbackUsableRef.current) return true;
      const health = readStyleHealth(map);
      if (!health.hasStyle || health.sourceCount === 0) return false;
      styleFallbackUsableRef.current = true;
      logWeatherOverlay('forcing style usability fallback', {
        trigger,
        isStyleLoaded: health.isStyleLoaded,
        sourceCount: health.sourceCount,
        layerCount: health.layerCount,
      });
      return true;
    };

    const setVisibility = (key: WeatherOverlayMetric, visible: boolean) => {
      try {
        if (map.getLayer(layerId(key))) {
          map.setLayoutProperty(layerId(key), 'visibility', visible ? 'visible' : 'none');
        }
      } catch {
        /* no-op */
      }
    };

    const setLayerPaint = (key: WeatherOverlayMetric, mode: WeatherOverlayMode) => {
      try {
        if (map.getLayer(layerId(key))) {
          map.setPaintProperty(layerId(key), 'raster-opacity', paletteOpacity(stateRef.current, key));
          map.setPaintProperty(layerId(key), 'raster-resampling', mode === 'fill' ? 'nearest' : 'linear');
        }
      } catch {
        /* no-op */
      }
    };

    const publishStyleSyncStatus = (progress: number) => {
      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo',
        state: 'loading',
        progress: Math.max(0, Math.min(99, progress)),
        detail: 'Synchronisation du style',
        reloadable: true,
      }));
    };

    const maybeLogStyleBlock = (reason: RefreshReason, trigger: string) => {
      const now = Date.now();
      if (now - lastStyleBlockLogAtRef.current < 1_000) return;
      lastStyleBlockLogAtRef.current = now;
      const health = readStyleHealth(map);
      logWeatherOverlay('waiting for style sync', {
        reason,
        trigger,
        isStyleLoaded: health.isStyleLoaded,
        hasStyle: health.hasStyle,
        sourceCount: health.sourceCount,
        layerCount: health.layerCount,
        fallbackUsable: styleFallbackUsableRef.current,
      });
    };

    const scheduleStyleRetry = () => {
      if (styleRetryRef.current != null) return;
      styleRetryRef.current = window.setTimeout(() => {
        styleRetryRef.current = null;
        if (cancelled) return;
        scheduleRefreshRef.current?.('force');
      }, STYLE_SYNC_RETRY_MS);
    };

    const completeStyleRecovery = () => {
      clearStyleRecoveryTimers();
    };

    const armStyleRecovery = (reason: RefreshReason, trigger: string) => {
      publishStyleSyncStatus(styleSyncProgress(reason));
      scheduleStyleRetry();
      maybeLogStyleBlock(reason, trigger);

      if (styleWatchdogRef.current == null) {
        styleWatchdogRef.current = window.setTimeout(() => {
          styleWatchdogRef.current = null;
          if (cancelled || canMutateStyle()) return;
          const health = readStyleHealth(map);
          console.warn('[weather-overlay] style sync watchdog fired', {
            reason,
            trigger,
            isStyleLoaded: health.isStyleLoaded,
            hasStyle: health.hasStyle,
            sourceCount: health.sourceCount,
            layerCount: health.layerCount,
          });
          if (promoteStyleFallbackIfUsable('watchdog')) {
            completeStyleRecovery();
            scheduleRefreshRef.current?.('force');
            return;
          }
          if (stylePollRef.current != null) return;
          stylePollCountRef.current = 0;
          stylePollRef.current = window.setInterval(() => {
            if (cancelled) {
              if (stylePollRef.current != null) {
                window.clearInterval(stylePollRef.current);
                stylePollRef.current = null;
              }
              return;
            }
            stylePollCountRef.current += 1;
            if (canMutateStyle() || promoteStyleFallbackIfUsable('poll')) {
              logWeatherOverlay('style sync recovered', {
                via: canMutateStyle() ? 'poll-ready' : 'poll-fallback',
                polls: stylePollCountRef.current,
              });
              completeStyleRecovery();
              if (stylePollRef.current != null) {
                window.clearInterval(stylePollRef.current);
                stylePollRef.current = null;
              }
              stylePollCountRef.current = 0;
              scheduleRefreshRef.current?.('force');
              return;
            }
            if (stylePollCountRef.current >= STYLE_SYNC_MAX_POLLS) {
              console.warn('[weather-overlay] style sync polling exhausted', {
                polls: stylePollCountRef.current,
                ...readStyleHealth(map),
              });
              if (stylePollRef.current != null) {
                window.clearInterval(stylePollRef.current);
                stylePollRef.current = null;
              }
              stylePollCountRef.current = 0;
            }
          }, STYLE_SYNC_POLL_MS);
        }, STYLE_SYNC_WATCHDOG_MS);
      }
    };

    const hideAll = () => {
      for (const key of SUPPORTED_KEYS) setVisibility(key, false);
      publishStatus(null);
    };

    const ensureLayer = (
      key: WeatherOverlayMetric,
      mode: WeatherOverlayMode,
      url: string,
      coords: ReturnType<typeof imageCoords>,
    ): boolean => {
      if (!canMutateStyle()) return false;
      try {
        if (!map.getSource(sourceId(key))) {
          map.addSource(sourceId(key), {
            type: 'image',
            url,
            coordinates: coords,
          } as never);
        }
        if (!map.getLayer(layerId(key))) {
          map.addLayer({
            id: layerId(key),
            type: 'raster',
            source: sourceId(key),
            slot: 'top',
            paint: {
              'raster-opacity': 1,
              'raster-fade-duration': 0,
              'raster-resampling': mode === 'fill' ? 'nearest' : 'linear',
            },
          } as never);
        }
        const source = map.getSource(sourceId(key)) as ImageSource | undefined;
        source?.updateImage({ url, coordinates: coords });
        setLayerPaint(key, mode);
        setVisibility(key, true);
        return true;
      } catch {
        return false;
      }
    };

    const renderFromData = async (dataset: WeatherGridDataset | null, progressBase = 76): Promise<boolean> => {
      if (!dataset) {
        hideAll();
        return true;
      }
      if (!canMutateStyle()) {
        armStyleRecovery('force', 'renderFromData-precheck');
        return false;
      }

      const currentActiveLayers = activeRenderableLayers(stateRef.current);
      if (!stateRef.current.enabled || currentActiveLayers.length === 0) {
        hideAll();
        return true;
      }

      const coords = imageCoords(dataset.grid.bounds);
      const size = getOverlayRenderSize(map);
      const activeLayerMap = new Map(currentActiveLayers.map((layer) => [layer.key, layer] as const));
      const renderableCount = Math.max(1, currentActiveLayers.length);
      let renderedCount = 0;
      for (const key of SUPPORTED_KEYS) {
        const activeLayer = activeLayerMap.get(key);
        if (!activeLayer) {
          setVisibility(key, false);
          continue;
        }

        const signature = [
          dataset.selectionKey,
          dataset.fetchedAt,
          activeLayer.mode,
          `${size.width}x${size.height}`,
          paletteSignature(stateRef.current, key),
        ].join('|');
        const rendered = renderedRef.current[key];
        if (rendered && rendered.signature === signature && coordsEqual(rendered.coords, coords)) {
          if (!ensureLayer(key, activeLayer.mode, rendered.url, rendered.coords)) {
            armStyleRecovery('force', `ensureLayer-reuse:${key}`);
            return false;
          }
          renderedCount += 1;
          publishStatus(createOverlayStatus({
            id: STATUS_ID,
            label: 'Météo',
            state: 'loading',
            progress: progressBase + (renderedCount / renderableCount) * 18,
            detail: 'Rendu',
            reloadable: true,
          }));
          continue;
        }

        const palette = stateRef.current.palettes?.[key];
        const canvas = renderWeatherCanvas(
          key,
          activeLayer.mode,
          dataset.grid,
          dataset.samples,
          size.width,
          size.height,
          palette?.bands,
        );
        const url = await canvasToObjectUrl(canvas);
        await preload(url);
        if (!canMutateStyle()) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          armStyleRecovery('force', `render-url-ready:${key}`);
          return false;
        }
        if (!ensureLayer(key, activeLayer.mode, url, coords)) {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          armStyleRecovery('force', `ensureLayer-new:${key}`);
          return false;
        }
        if (rendered?.url.startsWith('blob:')) {
          window.setTimeout(() => URL.revokeObjectURL(rendered.url), 1_000);
        }
        renderedRef.current[key] = { url, coords, signature };
        renderedCount += 1;
        publishStatus(createOverlayStatus({
          id: STATUS_ID,
          label: 'Météo',
          state: 'loading',
          progress: progressBase + (renderedCount / renderableCount) * 18,
          detail: 'Rendu',
          reloadable: true,
        }));
      }

      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo',
        state: 'ready',
        progress: 100,
        detail: 'Overlay prêt',
        reloadable: true,
      }));
      clearStyleRecoveryTimers();
      return true;
    };

    const refresh = async (reason: RefreshReason) => {
      if (!canMutateStyle()) {
        armStyleRecovery(reason, 'refresh-precheck');
        return;
      }

      if (styleFallbackUsableRef.current) {
        const health = readStyleHealth(map);
        logWeatherOverlay('refresh proceeding with style fallback', {
          reason,
          isStyleLoaded: health.isStyleLoaded,
          sourceCount: health.sourceCount,
          layerCount: health.layerCount,
        });
      }

      const nextState = stateRef.current;
      const currentActiveLayers = activeRenderableLayers(nextState);
      if (!nextState.enabled || currentActiveLayers.length === 0) {
        hideAll();
        return;
      }

      const explicitReload = reason === 'reload';
      const force = reason !== 'normal';

      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo',
        state: 'loading',
        progress: explicitReload ? 8 : 12,
        detail: explicitReload ? 'Actualisation' : 'Préparation',
        reloadable: true,
      }));

      const selection = selectionFromState(nextState);
      const viewport = getViewportBounds(map);
      const activeMetrics = currentActiveLayers.map((layer) => layer.key);
      const dataSelectionKey = weatherDataSelectionKey(selection, activeMetrics);
      const currentDataset = dataRef.current;
      const sameSelection = currentDataset?.selectionKey === dataSelectionKey;
      const reusableGrid = currentDataset
        ? weatherGridSupportsViewport(currentDataset.grid, viewport, selection.mode, activeMetrics)
        : false;

      if (!explicitReload && currentDataset && sameSelection && reusableGrid) {
        lastViewportRef.current = viewport;
        await renderFromData(currentDataset, 78);
        return;
      }

      if (
        !explicitReload
        && !force
        && sameSelection
        && Date.now() - lastFetchTimeRef.current < MIN_FETCH_INTERVAL_MS
        && currentDataset
        && containsBounds(currentDataset.grid.bounds, viewport)
        && weatherGridSupportsViewport(currentDataset.grid, viewport, selection.mode, activeMetrics)
      ) {
        await renderFromData(currentDataset);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const generation = ++generationRef.current;

      try {
        if (explicitReload) {
          clearWeatherOverlayCache();
          lastFetchTimeRef.current = 0;
        }
        publishStatus(createOverlayStatus({
          id: STATUS_ID,
          label: 'Météo',
          state: 'loading',
          progress: 24,
          detail: 'Grille météo',
          reloadable: true,
        }));
        const grid = buildWeatherGrid(map, selection.mode, activeMetrics);
        logWeatherOverlay('grid prepared', {
          reason,
          selection: selection.key,
          rows: grid.rows,
          cols: grid.cols,
          spacing: grid.spacing,
          points: grid.points.length,
        });
        publishStatus(createOverlayStatus({
          id: STATUS_ID,
          label: 'Météo',
          state: 'loading',
          progress: 32,
          detail: 'Téléchargement',
          reloadable: true,
        }));
        const samples = await fetchWeatherGridData(
          selection,
          grid,
          activeMetrics,
          controller.signal,
          (completed, total) => {
            publishStatus(createOverlayStatus({
              id: STATUS_ID,
              label: 'Météo',
              state: 'loading',
              progress: 32 + (Math.max(0, completed) / Math.max(1, total)) * 40,
              detail: 'Téléchargement',
              reloadable: true,
            }));
          },
        );
        if (controller.signal.aborted || generation !== generationRef.current) return;
        dataRef.current = {
          selectionKey: dataSelectionKey,
          grid,
          samples,
          fetchedAt: Date.now(),
        };
        logWeatherOverlay('samples fetched', {
          selection: selection.key,
          count: samples.length,
          generation,
        });
        lastViewportRef.current = viewport;
        lastFetchTimeRef.current = Date.now();
        await renderFromData(dataRef.current, 76);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[weather-overlay]', error);
        publishStatus(createOverlayStatus({
          id: STATUS_ID,
          label: 'Météo',
          state: 'error',
          progress: 0,
          detail: error instanceof Error ? error.message : 'Chargement impossible',
          reloadable: true,
        }));
      }
    };

    const scheduleRefresh = (reason: RefreshReason) => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (reason !== 'normal') {
        debounceRef.current = null;
        void refresh(reason);
        return;
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void refresh('normal');
      }, MOVE_DEBOUNCE_MS);
    };

    const onMoveEnd = () => scheduleRefresh('normal');
    const onZoomEnd = () => scheduleRefresh('normal');
    const onStyleData = () => {
      if (!styleRecoveryActive()) return;
      if (canMutateStyle() || promoteStyleFallbackIfUsable('styledata')) {
        logWeatherOverlay('styledata recovery event', {
          fallbackUsable: styleFallbackUsableRef.current,
          ...readStyleHealth(map),
        });
        completeStyleRecovery();
        scheduleRefresh('force');
        return;
      }
      armStyleRecovery('force', 'styledata');
    };
    const onStyleLoad = () => {
      if (!canMutateStyle() && !promoteStyleFallbackIfUsable('style.load')) {
        armStyleRecovery('force', 'style.load');
        return;
      }
      logWeatherOverlay('style.load recovery event', {
        fallbackUsable: styleFallbackUsableRef.current,
        ...readStyleHealth(map),
      });
      completeStyleRecovery();
      const currentActiveLayers = activeRenderableLayers(stateRef.current);
      if (!stateRef.current.enabled || currentActiveLayers.length === 0) {
        hideAll();
        return;
      }
      for (const activeLayer of currentActiveLayers) {
        const rendered = renderedRef.current[activeLayer.key];
        if (rendered) ensureLayer(activeLayer.key, activeLayer.mode, rendered.url, rendered.coords);
      }
      scheduleRefresh('force');
    };

    hideAllRef.current = hideAll;
    scheduleRefreshRef.current = scheduleRefresh;

    map.on('moveend', onMoveEnd);
    map.on('zoomend', onZoomEnd);
    map.on('styledata', onStyleData);
    map.on('style.load', onStyleLoad);

    return () => {
      cancelled = true;
      generationRef.current += 1;
      map.off('moveend', onMoveEnd);
      map.off('zoomend', onZoomEnd);
      map.off('styledata', onStyleData);
      map.off('style.load', onStyleLoad);
      scheduleRefreshRef.current = null;
      hideAllRef.current = null;
      abortRef.current?.abort();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      clearStyleRecoveryTimers();
      styleFallbackUsableRef.current = false;
      for (const rendered of Object.values(renderedRef.current)) {
        if (rendered?.url.startsWith('blob:')) URL.revokeObjectURL(rendered.url);
      }
      renderedRef.current = {};
      for (const key of SUPPORTED_KEYS) {
        try {
          if (map.getLayer(layerId(key))) map.removeLayer(layerId(key));
          if (map.getSource(sourceId(key))) map.removeSource(sourceId(key));
        } catch {
          /* no-op */
        }
      }
      clearWeatherOverlayCache();
      publishStatus(null);
    };
  }, [isMapLoaded, map, statusReporter]);

  useEffect(() => {
    if (!registerReload) return;
    if (!map || !isMapLoaded || !state.enabled || activeLayers.length === 0) {
      registerReload(null);
      return;
    }
    registerReload(() => {
      scheduleRefreshRef.current?.('reload');
    });
    return () => {
      registerReload(null);
    };
  }, [activeLayers.length, isMapLoaded, map, registerReload, state.enabled]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!state.enabled || activeLayers.length === 0) {
      hideAllRef.current?.();
      return;
    }
    scheduleRefreshRef.current?.('force');
  }, [map, isMapLoaded, state.enabled, activeLayers.length, activeLayersKey, selectionKey, paletteKey]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    for (const layer of activeLayers) {
      try {
        if (map.getLayer(layerId(layer.key))) {
          map.setPaintProperty(layerId(layer.key), 'raster-opacity', paletteOpacity(state, layer.key));
          map.setPaintProperty(layerId(layer.key), 'raster-resampling', layer.mode === 'fill' ? 'nearest' : 'linear');
        }
      } catch {
        /* layer may not exist yet */
      }
    }
  }, [map, isMapLoaded, activeLayers, opacityKey, state.palettes]);
}