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
import {
  fetchWeatherMeta,
  findClosestForecastHour,
  buildVpsTileUrl,
  bboxToImageCoords,
  loadTileImage,
  prefetchAdjacentHours,
} from '../vpsWeatherClient';
import {
  recolorTileToCanvas,
  canvasToBlobUrl,
} from '../vpsTileRenderer';
import {
  fetchRadarMeta,
  getLatestRadarFrame,
  buildRadarTileUrl,
  formatRadarPaletteParam,
  isInstantT,
} from '../../radar/radarClient';

interface UseWeatherDataPipelineArgs {
  map: MapboxMap | null;
  stateRef: React.MutableRefObject<WeatherOverlayState>;
  renderedRef: React.MutableRefObject<Partial<Record<WeatherOverlayMetric, RenderedLayerEntry>>>;
  canMutateStyle: () => boolean;
  armStyleRecovery: (reason: RefreshReason, trigger: string) => void;
  completeStyleRecovery: () => void;
  hideAll: () => void;
  setVisibility: (key: WeatherOverlayMetric, visible: boolean) => void;
  ensureLayer: (
    key: WeatherOverlayMetric,
    mode: WeatherOverlayMode,
    url: string,
    coords: ReturnType<typeof imageCoords>,
  ) => boolean;
  ensureRadarLayer?: (tileUrl: string, opacity: number) => boolean;
  setRadarVisibility?: (visible: boolean) => void;
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
  setVisibility,
  ensureLayer,
  ensureRadarLayer,
  setRadarVisibility,
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
    completeStyleRecovery();
    return true;
  };

  const renderVpsForecast = async (generation: number, reason: RefreshReason = 'normal'): Promise<boolean> => {
    if (!map || isCancelled() || !canMutateStyle()) return false;
    const currentState = stateRef.current;
    const currentActiveLayers = activeRenderableLayers(currentState);
    if (!currentState.enabled || currentActiveLayers.length === 0) {
      hideAll();
      return true;
    }

    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo (VPS)',
      state: 'loading',
      progress: 30,
      detail: 'Connexion serveur météo VPS',
      reloadable: true,
    }));

    const meta = await fetchWeatherMeta(undefined, reason === 'reload');
    if (generation !== generationRef.current || isCancelled()) return false;

    if (!meta || !Array.isArray(meta.hours) || meta.hours.length === 0) {
      throw new Error('Données météo non disponibles sur le serveur');
    }

    const closestHour = findClosestForecastHour(currentState.date, currentState.time, meta.hours);
    if (!closestHour) {
      throw new Error('Heure de prévision non trouvée');
    }
    const coords = bboxToImageCoords(meta.bbox);
    const renderableCount = Math.max(1, currentActiveLayers.length);
    let renderedCount = 0;

    const activeLayerMap = new Map(currentActiveLayers.map((layer) => [layer.key, layer] as const));
    for (const key of SUPPORTED_KEYS) {
      const activeLayer = activeLayerMap.get(key);
      if (!activeLayer) {
        setVisibility(key, false);
        if (key === 'rain') setRadarVisibility?.(false);
        continue;
      }

      // Real-time Doppler Radar observation at Instant T (only when radarEnabled is toggled on)
      if (key === 'rain') {
        const isLive = (currentState.radarEnabled ?? true) && isInstantT(currentState.date, currentState.time);
        if (isLive) {
          try {
            const radarMeta = await fetchRadarMeta();
            const latestFrame = getLatestRadarFrame(radarMeta);
            if (latestFrame && ensureRadarLayer) {
              const sig = paletteSignature(currentState, 'rain');
              const pParam = formatRadarPaletteParam(currentState.palettes?.rain?.bands, activeLayer.mode);
              const radarTileUrl = buildRadarTileUrl(radarMeta.host, latestFrame.path, sig, pParam);
              const opacity = (currentState.palettes?.rain?.opacity ?? 85) / 100;
              if (ensureRadarLayer(radarTileUrl, opacity)) {
                // Live Doppler Radar is actively displayed with user's custom palette
                setVisibility('rain', false);
                renderedCount += 1;
                continue;
              }
            }
          } catch (radarErr) {
            console.warn('[weather-radar] Radar fallback to VPS forecast model:', radarErr);
          }
        }
        // When radar is not toggled on, hide radar and proceed to recolor forecast with user's custom palette
        setRadarVisibility?.(false);
      }

      const signature = [
        'vps',
        closestHour,
        activeLayer.mode,
        paletteSignature(currentState, key),
      ].join('|');

      const rendered = renderedRef.current[key];
      if (rendered && rendered.signature === signature && coordsEqual(rendered.coords, coords)) {
        if (!ensureLayer(key, activeLayer.mode, rendered.url, rendered.coords)) {
          armStyleRecovery('force', `vps-reuse:${key}`);
          return false;
        }
        renderedCount += 1;
        continue;
      }

      // Load high-resolution raster tile from VPS (instant memory cache + HTTP/2)
      const tileUrl = buildVpsTileUrl(key, closestHour, meta.tileFormat || 'png');
      let img: HTMLImageElement;
      try {
        img = await loadTileImage(tileUrl);
      } catch (decodeErr) {
        if (generation !== generationRef.current || isCancelled()) return false;
        console.warn(`[weather-vps] Failed to load tile for ${key}:`, decodeErr);
        throw new Error(`Tuile météo indisponible (${key})`);
      }

      // Prefetch adjacent hours (+1h, +2h, -1h) in background for instant 60 FPS timeline scrubbing
      prefetchAdjacentHours(key, closestHour, meta.hours, meta.tileFormat || 'png');

      if (generation !== generationRef.current || isCancelled() || !canMutateStyle()) return false;

      // Ultra-fast 1ms 1D color table recoloring
      const palette = currentState.palettes?.[key];
      const varSpec = meta.variables[key];
      const canvas = recolorTileToCanvas(
        img,
        key,
        activeLayer.mode,
        palette?.bands,
        varSpec?.min ?? -40,
        varSpec?.max ?? 50,
      );

      const blobUrl = await canvasToBlobUrl(canvas);
      if (generation !== generationRef.current || isCancelled() || !canMutateStyle()) {
        if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
        return false;
      }

      if (!ensureLayer(key, activeLayer.mode, blobUrl, coords)) {
        if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
        armStyleRecovery('force', `vps-new:${key}`);
        return false;
      }

      if (rendered?.url.startsWith('blob:')) {
        window.setTimeout(() => URL.revokeObjectURL(rendered.url), 1_000);
      }
      renderedRef.current[key] = { url: blobUrl, coords, signature };
      renderedCount += 1;

      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo (VPS)',
        state: 'loading',
        progress: 40 + (renderedCount / renderableCount) * 55,
        detail: `Rendu ${key}`,
        reloadable: true,
      }));
    }

    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo (VPS)',
      state: 'ready',
      progress: 100,
      detail: 'Overlay VPS prêt',
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

    // Primary path for Forecast +2d: VPS 2D raster textures
    if (selection.mode === 'forecast') {
      try {
        const vpsSuccess = await renderVpsForecast(currentGeneration, reason);
        if (currentGeneration !== generationRef.current || isCancelled()) return;
        if (!vpsSuccess && !canMutateStyle()) {
          armStyleRecovery(reason, 'vps-style-not-ready');
        }
      } catch (vpsErr) {
        if (currentGeneration !== generationRef.current || isCancelled()) return;
        console.warn('[weather-overlay] VPS tile pipeline error:', vpsErr);
        publishStatus(createOverlayStatus({
          id: STATUS_ID,
          label: 'Météo (VPS)',
          state: 'error',
          detail: vpsErr instanceof Error ? vpsErr.message : 'Erreur chargement météo VPS',
          reloadable: true,
        }));
      }
      return;
    }

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
