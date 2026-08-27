import { useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';
import type { WeatherOverlayMetric, WeatherOverlayMode, WeatherOverlayState } from '../types';
import {
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
  imageCoords,
  logWeatherOverlay,
  paletteOpacity,
  readStyleHealth,
  styleSyncProgress,
  type RenderedLayerEntry,
} from './helpers';
import { createOverlayStatus } from '@/features/map3d';

interface UseWeatherStyleManagerArgs {
  map: MapboxMap | null;
  stateRef: React.MutableRefObject<WeatherOverlayState>;
  renderedRef: React.MutableRefObject<Partial<Record<WeatherOverlayMetric, RenderedLayerEntry>>>;
  publishStatus: (status: ReturnType<typeof createOverlayStatus> | null) => void;
  onRefreshRequest: (reason: RefreshReason) => void;
  isCancelled: () => boolean;
}

export function useWeatherStyleManager({
  map,
  stateRef,
  renderedRef,
  publishStatus,
  onRefreshRequest,
  isCancelled,
}: UseWeatherStyleManagerArgs) {
  const styleRetryRef = useRef<number | null>(null);
  const styleWatchdogRef = useRef<number | null>(null);
  const stylePollRef = useRef<number | null>(null);
  const styleFallbackUsableRef = useRef(false);
  const stylePollCountRef = useRef(0);
  const lastStyleBlockLogAtRef = useRef(0);

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

  const promoteStyleFallbackIfUsable = (trigger: string): boolean => {
    if (!map) return false;
    if (styleFallbackUsableRef.current) return true;
    const health = readStyleHealth(map);
    if (!health.hasStyle) return false;
    const hasEnoughStyleContent = health.sourceCount > 0 || health.layerCount > 0 || health.hasImportContent;
    if (!hasEnoughStyleContent) return false;
    styleFallbackUsableRef.current = true;
    logWeatherOverlay('forcing style usability fallback', {
      trigger,
      isStyleLoaded: health.isStyleLoaded,
      sourceCount: health.sourceCount,
      layerCount: health.layerCount,
      importCount: health.importCount,
      hasImportContent: health.hasImportContent,
    });
    return true;
  };

  const canMutateStyle = (): boolean => {
    if (isCancelled() || !map) return false;
    try {
      if (styleFallbackUsableRef.current) {
        const style = map.getStyle();
        return Boolean(style) && Object.keys(style.sources ?? {}).length > 0;
      }
      if (map.isStyleLoaded() && Boolean(map.getStyle())) return true;
      if (promoteStyleFallbackIfUsable('canMutateStyle-eager')) {
        const style = map.getStyle();
        return Boolean(style) && Object.keys(style.sources ?? {}).length > 0;
      }
      return false;
    } catch {
      return false;
    }
  };

  const setVisibility = (key: WeatherOverlayMetric, visible: boolean) => {
    if (!map) return;
    try {
      if (map.getLayer(layerId(key))) {
        map.setLayoutProperty(layerId(key), 'visibility', visible ? 'visible' : 'none');
      }
    } catch {
      /* no-op */
    }
  };

  const setLayerPaint = (key: WeatherOverlayMetric, mode: WeatherOverlayMode) => {
    if (!map) return;
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
    if (!map) return;
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
      if (isCancelled()) return;
      onRefreshRequest('force');
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
        if (isCancelled() || canMutateStyle() || !map) return;
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
          onRefreshRequest('force');
          return;
        }
        if (stylePollRef.current != null) return;
        stylePollCountRef.current = 0;
        stylePollRef.current = window.setInterval(() => {
          if (isCancelled()) {
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
            onRefreshRequest('force');
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

  const removeAll = () => {
    clearStyleRecoveryTimers();
    if (!map) return;
    for (const key of SUPPORTED_KEYS) {
      try {
        if (map.getLayer(layerId(key))) map.removeLayer(layerId(key));
        if (map.getSource(sourceId(key))) map.removeSource(sourceId(key));
      } catch {
        /* no-op */
      }
    }
    for (const rendered of Object.values(renderedRef.current)) {
      if (rendered?.url.startsWith('blob:')) {
        window.setTimeout(() => URL.revokeObjectURL(rendered.url), 1_000);
      }
    }
    renderedRef.current = {};
    styleFallbackUsableRef.current = false;
    publishStatus(null);
  };

  const ensureLayer = (
    key: WeatherOverlayMetric,
    mode: WeatherOverlayMode,
    url: string,
    coords: ReturnType<typeof imageCoords>,
  ): boolean => {
    if (!map || !canMutateStyle()) return false;
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

  return {
    canMutateStyle,
    setVisibility,
    setLayerPaint,
    armStyleRecovery,
    completeStyleRecovery,
    clearStyleRecoveryTimers,
    hideAll,
    removeAll,
    ensureLayer,
  };
}
