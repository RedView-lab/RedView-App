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
  SCRUB_DEBOUNCE_MS,
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
  cancelPrefetch,
  getCachedWeatherMeta,
} from '../vpsWeatherClient';
import {
  recolorTileToCanvas,
  canvasToBlobUrl,
  getCachedRecoloredBlob,
  cacheRecoloredBlob,
  preRecolorTile,
  releaseOverlayBlobUrl,
} from '../vpsTileRenderer';
import {
  fetchRadarMeta,
  getLatestRadarFrame,
  buildRadarTileUrl,
  formatRadarPaletteParam,
  isInstantT,
} from '../../radar/radarClient';

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('AbortError'))) return true;
  const msg = String(err);
  return msg.includes('AbortError') || msg.includes('aborted');
}

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
  clearStyleRecoveryTimers?: () => void;
  hideLayerCompletely?: (key: WeatherOverlayMetric) => boolean;
  hideRadarCompletely?: () => boolean;
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
  clearStyleRecoveryTimers,
  hideAll,
  hideLayerCompletely,
  hideRadarCompletely,
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
        if (hideLayerCompletely) hideLayerCompletely(key);
        else setVisibility(key, false);
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
      // L'URL remplacée peut être une tuile VPS détenue par le cache recoloré.
      releaseOverlayBlobUrl(rendered?.url, 1_000);
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

  const renderVpsForecast = async (
    generation: number,
    reason: RefreshReason = 'normal',
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (!map || isCancelled() || signal?.aborted || !canMutateStyle()) return false;
    const currentState = stateRef.current;
    const currentActiveLayers = activeRenderableLayers(currentState);
    if (!currentState.enabled || currentActiveLayers.length === 0) {
      hideAll();
      return true;
    }

    // 1. ULTRA-FAST INSTANT MEMORY PATH (< 1 ms):
    // If metadata and all active layer textures/blobs are already in memory, apply them immediately
    // without ANY network delay or loading flicker (no 20% loading flash).
    const cachedMeta = getCachedWeatherMeta();
    if (cachedMeta && Array.isArray(cachedMeta.hours) && cachedMeta.hours.length > 0) {
      const closestHour = findClosestForecastHour(currentState.date, currentState.time, cachedMeta.hours);
      if (closestHour) {
        const coords = bboxToImageCoords(cachedMeta.bbox);
        let allInstant = true;

        for (const activeLayer of currentActiveLayers) {
          if (activeLayer.key === 'rain') {
            const isLive = (currentState.radarEnabled ?? true) && isInstantT(currentState.date, currentState.time);
            if (isLive) {
              allInstant = false;
              break;
            }
          }
          const sig = ['vps', closestHour, activeLayer.mode, paletteSignature(currentState, activeLayer.key)].join('|');
          const rendered = renderedRef.current[activeLayer.key];
          const hasRendered = rendered && rendered.signature === sig && coordsEqual(rendered.coords, coords);
          const hasBlob = Boolean(getCachedRecoloredBlob(sig));
          if (!hasRendered && !hasBlob) {
            allInstant = false;
            break;
          }
        }

        if (allInstant) {
          const freshActive = activeRenderableLayers(stateRef.current);
          if (!stateRef.current.enabled || freshActive.length === 0) {
            hideAll();
            return true;
          }

          const activeKeySet = new Set(freshActive.map((l) => l.key));
          for (const key of SUPPORTED_KEYS) {
            if (!activeKeySet.has(key)) {
              if (hideLayerCompletely) hideLayerCompletely(key);
              else setVisibility(key, false);
              if (key === 'rain') {
                if (hideRadarCompletely) hideRadarCompletely();
                else setRadarVisibility?.(false);
              }
            }
          }

          for (const activeLayer of freshActive) {
            const key = activeLayer.key;
            const sig = ['vps', closestHour, activeLayer.mode, paletteSignature(stateRef.current, key)].join('|');
            const rendered = renderedRef.current[key];
            if (rendered && rendered.signature === sig && coordsEqual(rendered.coords, coords)) {
              ensureLayer(key, activeLayer.mode, rendered.url, rendered.coords);
            } else {
              const cachedBlob = getCachedRecoloredBlob(sig)!;
              ensureLayer(key, activeLayer.mode, cachedBlob, coords);
              renderedRef.current[key] = { url: cachedBlob, coords, signature: sig };
            }
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

          // Background prefetch adjacent hours in idle time
          for (const activeLayer of currentActiveLayers) {
            if (activeLayer.key !== 'rain' || !(currentState.radarEnabled && isInstantT(currentState.date, currentState.time))) {
              prefetchAdjacentHours(
                activeLayer.key,
                closestHour,
                cachedMeta.hours,
                cachedMeta.tileFormat || 'png',
                (_url, img, h) => {
                  const preSig = ['vps', h, activeLayer.mode, paletteSignature(currentState, activeLayer.key)].join('|');
                  const varSpec = cachedMeta.variables[activeLayer.key];
                  preRecolorTile(
                    img,
                    activeLayer.key,
                    activeLayer.mode,
                    currentState.palettes?.[activeLayer.key]?.bands,
                    varSpec?.min ?? -40,
                    varSpec?.max ?? 50,
                    preSig,
                  ).catch(() => {});
                },
              );
            }
          }

          return true;
        }
      }
    }

    // 2. NETWORK / PROCESSING PATH:
    // Only emit loading progress if actual async work is needed
    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo (VPS)',
      state: 'loading',
      progress: cachedMeta ? 40 : 25,
      detail: cachedMeta ? 'Chargement des prévisions' : 'Connexion serveur météo',
      reloadable: true,
    }));

    let meta: Awaited<ReturnType<typeof fetchWeatherMeta>>;
    try {
      meta = await fetchWeatherMeta(signal, reason === 'reload');
    } catch (metaErr) {
      if (isAbortError(metaErr) || generation !== generationRef.current || isCancelled() || signal?.aborted) return false;
      throw metaErr;
    }

    if (generation !== generationRef.current || isCancelled() || signal?.aborted) return false;

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

    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo (VPS)',
      state: 'loading',
      progress: 50,
      detail: 'Préparation des cartes',
      reloadable: true,
    }));

    for (const key of SUPPORTED_KEYS) {
      if (generation !== generationRef.current || isCancelled() || signal?.aborted) return false;

      const freshActiveNow = activeRenderableLayers(stateRef.current);
      if (!stateRef.current.enabled || freshActiveNow.length === 0) {
        hideAll();
        return true;
      }

      const activeLayer = freshActiveNow.find((l) => l.key === key);
      if (!activeLayer) {
        if (hideLayerCompletely) hideLayerCompletely(key);
        else setVisibility(key, false);
        if (key === 'rain') {
          if (hideRadarCompletely) hideRadarCompletely();
          else setRadarVisibility?.(false);
        }
        continue;
      }

      // Real-time Doppler Radar observation at Instant T (only when radarEnabled is toggled on)
      if (key === 'rain') {
        const isLive = (currentState.radarEnabled ?? true) && isInstantT(currentState.date, currentState.time);
        if (isLive) {
          try {
            const radarMeta = await fetchRadarMeta(signal);
            const latestFrame = getLatestRadarFrame(radarMeta);
            if (latestFrame && ensureRadarLayer) {
              const sig = paletteSignature(currentState, 'rain');
              const pParam = formatRadarPaletteParam(currentState.palettes?.rain?.bands, activeLayer.mode);
              const radarTileUrl = buildRadarTileUrl(radarMeta.host, latestFrame.path, sig, pParam);
              const opacity = (currentState.palettes?.rain?.opacity ?? 85) / 100;
              if (ensureRadarLayer(radarTileUrl, opacity)) {
                if (hideLayerCompletely) hideLayerCompletely('rain');
                else setVisibility('rain', false);
                renderedCount += 1;
                continue;
              }
            }
          } catch (radarErr) {
            console.warn('[weather-radar] Radar fallback to VPS forecast model:', radarErr);
          }
        }
        if (hideRadarCompletely) hideRadarCompletely();
        else setRadarVisibility?.(false);
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

      // Check client recolored blob cache (< 1ms instant display)
      const cachedBlob = getCachedRecoloredBlob(signature);
      if (cachedBlob) {
        if (!ensureLayer(key, activeLayer.mode, cachedBlob, coords)) {
          armStyleRecovery('force', `vps-cache-reuse:${key}`);
          return false;
        }
        renderedRef.current[key] = { url: cachedBlob, coords, signature };
        renderedCount += 1;
        continue;
      }

      // Load high-resolution raster tile from VPS (instant memory cache + HTTP/2)
      const tileUrl = buildVpsTileUrl(key, closestHour, meta.tileFormat || 'png');
      let img: HTMLImageElement;
      try {
        img = await loadTileImage(tileUrl, signal);
      } catch (decodeErr) {
        if (isAbortError(decodeErr) || generation !== generationRef.current || isCancelled() || signal?.aborted) return false;
        console.warn(`[weather-vps] Failed to load tile for ${key}:`, decodeErr);
        throw new Error(`Tuile météo indisponible (${key})`);
      }

      if (generation !== generationRef.current || isCancelled() || signal?.aborted || !canMutateStyle()) return false;

      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo (VPS)',
        state: 'loading',
        progress: 70 + Math.round((renderedCount / renderableCount) * 20),
        detail: `Affichage ${key}`,
        reloadable: true,
      }));

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
      if (generation !== generationRef.current || isCancelled() || signal?.aborted || !canMutateStyle()) {
        if (blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
        return false;
      }

      cacheRecoloredBlob(signature, blobUrl);

      const activeCheck = activeRenderableLayers(stateRef.current);
      if (!stateRef.current.enabled || !activeCheck.some((l) => l.key === key)) {
        // blobUrl vient d'entrer dans le cache : c'est lui qui la révoquera.
        releaseOverlayBlobUrl(blobUrl);
        if (hideLayerCompletely) hideLayerCompletely(key);
        else setVisibility(key, false);
        continue;
      }

      if (!ensureLayer(key, activeLayer.mode, blobUrl, coords)) {
        armStyleRecovery('force', `vps-new:${key}`);
        return false;
      }

      renderedRef.current[key] = { url: blobUrl, coords, signature };
      renderedCount += 1;

      // Prefetch adjacent hours in background and pre-recolor them
      prefetchAdjacentHours(
        key,
        closestHour,
        meta.hours,
        meta.tileFormat || 'png',
        (_url, preImg, h) => {
          const preSig = ['vps', h, activeLayer.mode, paletteSignature(currentState, key)].join('|');
          preRecolorTile(
            preImg,
            key,
            activeLayer.mode,
            palette?.bands,
            varSpec?.min ?? -40,
            varSpec?.max ?? 50,
            preSig,
          ).catch(() => {});
        },
      );
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
      cancelPipeline();
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

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    // Primary path for Forecast +2d: VPS 2D raster textures
    if (selection.mode === 'forecast') {
      try {
        const vpsSuccess = await renderVpsForecast(currentGeneration, reason, abortController.signal);
        if (currentGeneration !== generationRef.current || isCancelled() || abortController.signal.aborted) return;
        if (!vpsSuccess) {
          if (!canMutateStyle()) {
            armStyleRecovery(reason, 'vps-style-not-ready');
          } else {
            // Self-healing: Ensure status never stays frozen at loading/20%
            publishStatus(createOverlayStatus({
              id: STATUS_ID,
              label: 'Météo (VPS)',
              state: 'ready',
              progress: 100,
              detail: 'Overlay prêt',
              reloadable: true,
            }));
          }
        }
      } catch (vpsErr) {
        if (isAbortError(vpsErr) || currentGeneration !== generationRef.current || isCancelled() || abortController.signal.aborted) return;
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

  const scheduleRefresh = (
    reason: RefreshReason = 'normal',
    debounceMode: boolean | 'scrub' | 'move' = false,
  ) => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const delay = debounceMode === 'scrub'
      ? SCRUB_DEBOUNCE_MS
      : (debounceMode === true || debounceMode === 'move')
        ? MOVE_DEBOUNCE_MS
        : 0;

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
    generationRef.current += 1;
    abortRef.current?.abort();
    cancelPrefetch();
    clearStyleRecoveryTimers?.();
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
