import { useEffect, useMemo, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';
import { buildWeatherGrid, clearWeatherOverlayCache, fetchWeatherGridData } from './client';
import { renderWeatherCanvas } from './render';
import type {
  WeatherGridDataset,
  WeatherOverlayMetric,
  WeatherOverlayMode,
  WeatherOverlayState,
  WeatherSelection,
} from './types';

const SOURCE_PREFIX = 'weather-overlay-source';
const LAYER_PREFIX = 'weather-overlay-layer';
const SUPPORTED_KEYS: WeatherOverlayMetric[] = ['temperature', 'feelsLike', 'rain', 'cloudCover', 'humidity'];
const MOVE_DEBOUNCE_MS = 700;
const MIN_FETCH_INTERVAL_MS = 12_000;
const ZOOM_DELTA_THRESHOLD = 1.15;
const RENDER_MIN = 320;
const RENDER_MAX = 768;

interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
}

type ImageCoords = [[number, number], [number, number], [number, number], [number, number]];

function getViewportBounds(map: MapboxMap): ViewportBounds {
  const bounds = map.getBounds();
  return {
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
    zoom: map.getZoom(),
  };
}

function containsBounds(container: [number, number, number, number], viewport: ViewportBounds): boolean {
  return viewport.west >= container[0]
    && viewport.south >= container[1]
    && viewport.east <= container[2]
    && viewport.north <= container[3];
}

function roundToQuarterHour(time: string): string {
  const [hoursText, minutesText] = time.split(':');
  const hours = Number(hoursText || 0);
  const minutes = Number(minutesText || 0);
  const totalMinutes = hours * 60 + minutes;
  const rounded = Math.round(totalMinutes / 15) * 15;
  const clamped = Math.max(0, Math.min(23 * 60 + 45, rounded));
  const nextHours = String(Math.floor(clamped / 60)).padStart(2, '0');
  const nextMinutes = String(clamped % 60).padStart(2, '0');
  return `${nextHours}:${nextMinutes}`;
}

function forecastDateIso(offset: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function selectionFromState(state: WeatherOverlayState): WeatherSelection {
  if (state.tab === 'trends') {
    const monthIso = state.date.slice(0, 7);
    return { mode: 'trends', key: `trends:${monthIso}`, monthIso };
  }

  const dateIso = forecastDateIso(state.forecastDay ?? 0);
  const roundedTime = roundToQuarterHour(state.time || '00:00');
  return {
    mode: 'forecast',
    key: `forecast:${dateIso}T${roundedTime}`,
    forecastIso: `${dateIso}T${roundedTime}`,
  };
}

function sourceId(key: WeatherOverlayMetric): string {
  return `${SOURCE_PREFIX}-${key}`;
}

function layerId(key: WeatherOverlayMetric): string {
  return `${LAYER_PREFIX}-${key}`;
}

function activeRenderableLayers(state: WeatherOverlayState): { key: WeatherOverlayMetric; mode: WeatherOverlayMode }[] {
  return state.layers
    .filter((layer): layer is { key: WeatherOverlayMetric; enabled: boolean; mode: WeatherOverlayMode } =>
      SUPPORTED_KEYS.includes(layer.key as WeatherOverlayMetric)
      && layer.enabled
      && (layer.mode === 'gradient' || layer.mode === 'fill'),
    )
    .map((layer) => ({ key: layer.key, mode: layer.mode }));
}

function imageCoords(bounds: [number, number, number, number]): ImageCoords {
  return [
    [bounds[0], bounds[3]],
    [bounds[2], bounds[3]],
    [bounds[2], bounds[1]],
    [bounds[0], bounds[1]],
  ];
}

async function preload(url: string): Promise<void> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    if (image.decode) await image.decode();
  } catch {
    /* ignore */
  }
}

function renderSize(map: MapboxMap): { width: number; height: number } {
  const canvas = map.getCanvas();
  const width = canvas.width || canvas.clientWidth || RENDER_MIN;
  const height = canvas.height || canvas.clientHeight || RENDER_MIN;
  const aspect = width / Math.max(1, height);
  const targetWidth = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(width * 0.55)));
  const targetHeight = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(targetWidth / aspect)));
  return { width: targetWidth, height: targetHeight };
}

export function useWeatherOverlay(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  state: WeatherOverlayState,
): void {
  const stateRef = useRef(state);
  stateRef.current = state;

  const dataRef = useRef<WeatherGridDataset | null>(null);
  const lastViewportRef = useRef<ViewportBounds | null>(null);
  const lastFetchTimeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const scheduleRefreshRef = useRef<((force: boolean) => void) | null>(null);
  const hideAllRef = useRef<(() => void) | null>(null);
  const renderedRef = useRef<Partial<Record<WeatherOverlayMetric, { url: string; coords: ImageCoords }>>>({});

  const activeLayersKey = useMemo(
    () => activeRenderableLayers(state).map((layer) => `${layer.key}:${layer.mode}`).join('|'),
    [state],
  );
  const selectionKey = useMemo(() => selectionFromState(state).key, [state]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    const setVisibility = (key: WeatherOverlayMetric, visible: boolean) => {
      try {
        if (map.getLayer(layerId(key))) {
          map.setLayoutProperty(layerId(key), 'visibility', visible ? 'visible' : 'none');
        }
      } catch {
        /* no-op */
      }
    };

    const hideAll = () => {
      for (const key of SUPPORTED_KEYS) setVisibility(key, false);
    };

    const ensureLayer = (key: WeatherOverlayMetric, url: string, coords: ImageCoords) => {
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
            'raster-resampling': 'linear',
          },
        } as never);
      }
      const source = map.getSource(sourceId(key)) as ImageSource | undefined;
      source?.updateImage({ url, coordinates: coords });
      setVisibility(key, true);
    };

    const renderFromData = async (dataset: WeatherGridDataset | null) => {
      if (!dataset) {
        hideAll();
        return;
      }

      const activeLayers = activeRenderableLayers(stateRef.current);
      if (!stateRef.current.enabled || activeLayers.length === 0) {
        hideAll();
        return;
      }

      const coords = imageCoords(dataset.grid.bounds);
      const size = renderSize(map);
      for (const key of SUPPORTED_KEYS) {
        const activeLayer = activeLayers.find((layer) => layer.key === key);
        if (!activeLayer) {
          setVisibility(key, false);
          continue;
        }
        const canvas = renderWeatherCanvas(key, activeLayer.mode, dataset.grid, dataset.samples, size.width, size.height);
        const url = canvas.toDataURL('image/png');
        await preload(url);
        ensureLayer(key, url, coords);
        renderedRef.current[key] = { url, coords };
      }
    };

    const refresh = async (force: boolean) => {
      const nextState = stateRef.current;
      const activeLayers = activeRenderableLayers(nextState);
      if (!nextState.enabled || activeLayers.length === 0) {
        hideAll();
        return;
      }

      const selection = selectionFromState(nextState);
      const viewport = getViewportBounds(map);
      const currentDataset = dataRef.current;
      const sameSelection = currentDataset?.selectionKey === selection.key;
      const sameCoverage = currentDataset ? containsBounds(currentDataset.grid.bounds, viewport) : false;
      const zoomDelta = lastViewportRef.current ? Math.abs(lastViewportRef.current.zoom - viewport.zoom) : Number.POSITIVE_INFINITY;

      if (currentDataset && sameSelection && sameCoverage && (force || zoomDelta < ZOOM_DELTA_THRESHOLD)) {
        lastViewportRef.current = viewport;
        await renderFromData(currentDataset);
        return;
      }

      if (!force && sameSelection && Date.now() - lastFetchTimeRef.current < MIN_FETCH_INTERVAL_MS && currentDataset) {
        await renderFromData(currentDataset);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const generation = ++generationRef.current;

      try {
        const grid = buildWeatherGrid(map, selection.mode);
        const samples = await fetchWeatherGridData(selection, grid, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current) return;
        dataRef.current = {
          selectionKey: selection.key,
          grid,
          samples,
          fetchedAt: Date.now(),
        };
        lastViewportRef.current = viewport;
        lastFetchTimeRef.current = Date.now();
        await renderFromData(dataRef.current);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[weather-overlay]', error);
      }
    };

    const scheduleRefresh = (force: boolean) => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void refresh(force);
      }, force ? 120 : MOVE_DEBOUNCE_MS);
    };

    const onMoveEnd = () => scheduleRefresh(false);
    const onStyleLoad = () => {
      const activeLayers = activeRenderableLayers(stateRef.current);
      if (!stateRef.current.enabled || activeLayers.length === 0) {
        hideAll();
        return;
      }
      for (const activeLayer of activeLayers) {
        const rendered = renderedRef.current[activeLayer.key];
        if (rendered) ensureLayer(activeLayer.key, rendered.url, rendered.coords);
      }
      if (!dataRef.current) scheduleRefresh(true);
    };

    hideAllRef.current = hideAll;
    scheduleRefreshRef.current = scheduleRefresh;

    map.on('moveend', onMoveEnd);
    map.on('style.load', onStyleLoad);

    return () => {
      map.off('moveend', onMoveEnd);
      map.off('style.load', onStyleLoad);
      scheduleRefreshRef.current = null;
      hideAllRef.current = null;
      abortRef.current?.abort();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      for (const key of SUPPORTED_KEYS) {
        try {
          if (map.getLayer(layerId(key))) map.removeLayer(layerId(key));
          if (map.getSource(sourceId(key))) map.removeSource(sourceId(key));
        } catch {
          /* no-op */
        }
      }
      clearWeatherOverlayCache();
    };
  }, [map, isMapLoaded]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!state.enabled || activeRenderableLayers(state).length === 0) {
      hideAllRef.current?.();
      return;
    }
    scheduleRefreshRef.current?.(true);
  }, [map, isMapLoaded, state.enabled, activeLayersKey, selectionKey]);
}