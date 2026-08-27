import { useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  buildWeatherGrid,
  fetchWeatherGridData,
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
import { createOverlayStatus } from '@/features/map3d';
import {
  MIN_FETCH_INTERVAL_MS,
  MOVE_DEBOUNCE_MS,
  STATUS_ID,
  SUPPORTED_KEYS,
  type RefreshReason,
} from './constants';
import {
  activeRenderableLayers,
  canvasToObjectUrl,
  coordsEqual,
  getViewportBounds,
  imageCoords,
  paletteSignature,
  preload,
  selectionFromState,
  type RenderedLayerEntry,
  type ViewportBounds,
} from './helpers';

interface UseWeatherDataPipelineArgs {
  map: MapboxMap | null;
  stateRef: React.MutableRefObject<WeatherOverlayState>;
  renderedRef: React.MutableRefObject<Partial<Record<WeatherOverlayMetric, RenderedLayerEntry>>>;
  canMutateStyle: () => boolean;
  armStyleRecovery: (reason: RefreshReason, trigger: string) => void;
  completeStyleRecovery: () => void;
  hideAll: () => void;
  ensureLayer: (
    key: WeatherOverlayMetric,
    mode: WeatherOverlayMode,
    url: string,
    coords: ReturnType<typeof imageCoords>,
  ) => boolean;
  publishStatus: (status: ReturnType<typeof createOverlayStatus> | null) => void;
  isCancelled: () => boolean;
}

export function useWeatherDataPipeline({
  map,
  stateRef,
  renderedRef,
  canMutateStyle,
  armStyleRecovery,
  completeStyleRecovery,
  hideAll,
  ensureLayer,
  publishStatus,
  isCancelled,
}: UseWeatherDataPipelineArgs) {
  const dataRef = useRef<WeatherGridDataset | null>(null);
  const lastViewportRef = useRef<ViewportBounds | null>(null);
  const lastFetchTimeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const renderFromData = async (dataset: WeatherGridDataset | null, progressBase = 76): Promise<boolean> => {
    if (!dataset || !map) {
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
    completeStyleRecovery();
    return true;
  };

  const refresh = async (reason: RefreshReason = 'normal') => {
    const earlyState = stateRef.current;
    const earlyActive = activeRenderableLayers(earlyState);
    if (!earlyState.enabled || earlyActive.length === 0 || !map) {
      hideAll();
      return;
    }

    if (!canMutateStyle()) {
      armStyleRecovery(reason, 'refresh-precheck');
      return;
    }

    const currentGeneration = ++generationRef.current;
    const viewport = getViewportBounds(map);
    const selection = selectionFromState(earlyState);

    const now = Date.now();
    const existingDataset = dataRef.current;
    const supportsViewport = weatherGridSupportsViewport(existingDataset?.grid, viewport);
    const isSelectionMatch = existingDataset?.selectionKey === selection.key;
    const isWithinTtl = (now - lastFetchTimeRef.current) < MIN_FETCH_INTERVAL_MS;

    if (reason === 'normal') {
      if (existingDataset && isSelectionMatch && supportsViewport && isWithinTtl) {
        await renderFromData(existingDataset, 82);
        return;
      }
    }

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo',
      state: 'loading',
      progress: 25,
      detail: 'Récupération météo',
      reloadable: true,
    }));

    try {
      const grid = buildWeatherGrid(viewport, selection);
      const dataset = await fetchWeatherGridData(grid, selection, abortController.signal, (progress) => {
        if (currentGeneration !== generationRef.current || isCancelled()) return;
        publishStatus(createOverlayStatus({
          id: STATUS_ID,
          label: 'Météo',
          state: 'loading',
          progress: Math.min(74, 25 + Math.round(progress * 49)),
          detail: 'Téléchargement données',
          reloadable: true,
        }));
      });

      if (currentGeneration !== generationRef.current || isCancelled()) return;

      dataRef.current = dataset;
      lastViewportRef.current = viewport;
      lastFetchTimeRef.current = Date.now();

      await renderFromData(dataset, 76);
    } catch (err: unknown) {
      if (abortController.signal.aborted || isCancelled()) return;
      console.warn('[weather-overlay] fetch failed', err);
      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo',
        state: 'error',
        detail: err instanceof Error ? err.message : 'Erreur chargement météo',
        reloadable: true,
      }));
    }
  };

  const scheduleRefresh = (reason: RefreshReason = 'normal', isDebounced = false) => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const delay = isDebounced ? MOVE_DEBOUNCE_MS : 0;
    if (delay === 0) {
      void refresh(reason);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      if (isCancelled()) return;
      void refresh(reason);
    }, delay);
  };

  const cancelPipeline = () => {
    abortRef.current?.abort();
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  return {
    renderFromData,
    refresh,
    scheduleRefresh,
    cancelPipeline,
    dataRef,
  };
}
