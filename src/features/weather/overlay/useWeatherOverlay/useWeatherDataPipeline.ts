import { useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type {
  WeatherOverlayMetric,
  WeatherOverlayMode,
  WeatherOverlayState,
} from '../types';
import { createOverlayStatus } from '@/features/map3d';
import { translateAppText } from '@/shared/i18n';
import {
  MOVE_DEBOUNCE_MS,
  SCRUB_DEBOUNCE_MS,
  STATUS_ID,
  SUPPORTED_KEYS,
  type RefreshReason,
} from './constants';
import {
  activeRenderableLayers,
  coordsEqual,
  imageCoords,
  paletteSignature,
  type RenderedLayerEntry,
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
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const generationRef = useRef(0);

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

    // 1. CHEMIN INSTANTANÉ EN MÉMOIRE (< 1 ms) :
    // si les métadonnées et toutes les textures / blobs des couches actives sont
    // déjà en mémoire, on les applique tout de suite, sans AUCUN délai réseau ni
    // clignotement de chargement (pas de flash de chargement à 20 %).
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
          const sig = ['vps', cachedMeta.updatedAt, closestHour, activeLayer.mode, paletteSignature(currentState, activeLayer.key)].join('|');
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
            const sig = ['vps', cachedMeta.updatedAt, closestHour, activeLayer.mode, paletteSignature(stateRef.current, key)].join('|');
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
            detail: translateAppText('Overlay VPS prêt'),
            reloadable: true,
          }));
          completeStyleRecovery();

          // Préchargement en arrière-plan des heures voisines pendant l'inactivité
          for (const activeLayer of currentActiveLayers) {
            if (activeLayer.key !== 'rain' || !(currentState.radarEnabled && isInstantT(currentState.date, currentState.time))) {
              prefetchAdjacentHours(
                activeLayer.key,
                closestHour,
                cachedMeta.hours,
                cachedMeta.tileFormat || 'png',
                cachedMeta.updatedAt,
                (_url, img, h) => {
                  const preSig = ['vps', cachedMeta.updatedAt, h, activeLayer.mode, paletteSignature(currentState, activeLayer.key)].join('|');
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

    // 2. CHEMIN RÉSEAU / TRAITEMENT :
    // n'émet de progression de chargement que si un vrai travail asynchrone est nécessaire
    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo (VPS)',
      state: 'loading',
      progress: cachedMeta ? 40 : 25,
      detail: translateAppText(cachedMeta ? 'Chargement des prévisions' : 'Connexion serveur météo'),
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
      // Heure hors de l'horizon publié : rien à afficher plutôt qu'une autre heure.
      hideAll();
      return true;
    }
    const coords = bboxToImageCoords(meta.bbox);
    const renderableCount = Math.max(1, currentActiveLayers.length);
    let renderedCount = 0;

    publishStatus(createOverlayStatus({
      id: STATUS_ID,
      label: 'Météo (VPS)',
      state: 'loading',
      progress: 50,
      detail: translateAppText('Préparation des cartes'),
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

      // Observation radar Doppler en temps réel à l'instant T (seulement quand radarEnabled est activé)
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
        meta.updatedAt,
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

      // Regarde le cache des blobs recolorés côté client (affichage instantané < 1 ms)
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

      // Charge la tuile raster haute résolution du VPS (cache mémoire instantané + HTTP/2)
      const tileUrl = buildVpsTileUrl(key, closestHour, meta.tileFormat || 'png', meta.updatedAt);
      let img: HTMLImageElement;
      try {
        img = await loadTileImage(tileUrl, signal);
      } catch (decodeErr) {
        if (isAbortError(decodeErr) || generation !== generationRef.current || isCancelled() || signal?.aborted) return false;
        console.warn(`[weather-vps] Failed to load tile for ${key}:`, decodeErr);
        throw new Error(translateAppText('Tuile météo indisponible ({{layer}})', { layer: key }));
      }

      if (generation !== generationRef.current || isCancelled() || signal?.aborted || !canMutateStyle()) return false;

      publishStatus(createOverlayStatus({
        id: STATUS_ID,
        label: 'Météo (VPS)',
        state: 'loading',
        progress: 70 + Math.round((renderedCount / renderableCount) * 20),
        detail: translateAppText('Affichage {{layer}}', { layer: key }),
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

      // Précharge les heures voisines en arrière-plan et les recolore d'avance
      prefetchAdjacentHours(
        key,
        closestHour,
        meta.hours,
        meta.tileFormat || 'png',
        meta.updatedAt,
        (_url, preImg, h) => {
          const preSig = ['vps', meta.updatedAt, h, activeLayer.mode, paletteSignature(currentState, key)].join('|');
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
      detail: translateAppText('Overlay VPS prêt'),
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

    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;

    // Couches météo : textures 2D du VPS (DWD ICON-EU, J+2).
    try {
      const vpsSuccess = await renderVpsForecast(currentGeneration, reason, abortController.signal);
      if (currentGeneration !== generationRef.current || isCancelled() || abortController.signal.aborted) return;
      if (!vpsSuccess) {
        if (!canMutateStyle()) {
          armStyleRecovery(reason, 'vps-style-not-ready');
        } else {
          // Auto-réparation : le statut ne reste jamais figé sur chargement / 20 %
          publishStatus(createOverlayStatus({
            id: STATUS_ID,
            label: 'Météo (VPS)',
            state: 'ready',
            progress: 100,
            detail: translateAppText('Overlay prêt'),
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
        detail: translateAppText(vpsErr instanceof Error ? vpsErr.message : 'Erreur chargement météo VPS'),
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
    refresh,
    scheduleRefresh,
    cancelPipeline,
  };
}
