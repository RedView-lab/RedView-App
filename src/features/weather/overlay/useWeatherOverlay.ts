import { useEffect, useMemo, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';
import { buildWeatherGrid, clearWeatherOverlayCache, fetchWeatherGridData, weatherGridSupportsViewport } from './client';
import { clampForecastSelection } from '../lib/forecastTime.ts';
import { renderWeatherCanvas } from './render';
import type {
  WeatherGridDataset,
  WeatherOverlayMetric,
  WeatherOverlayMode,
  WeatherOverlayState,
  WeatherSelection,
} from './types';
import {
  createOverlayStatus,
  type OverlayReloadRegistrar,
  type OverlayStatusReporter,
} from '@/features/map3d/overlayStatus';

const SOURCE_PREFIX = 'weather-overlay-source';
const LAYER_PREFIX = 'weather-overlay-layer';
const SUPPORTED_KEYS: WeatherOverlayMetric[] = ['temperature', 'feelsLike', 'rain', 'cloudCover', 'humidity'];
const MOVE_DEBOUNCE_MS = 220;
const MIN_FETCH_INTERVAL_MS = 800;
const RENDER_MIN = 320;
const RENDER_MAX = 2048;
const STATUS_ID = 'weather';

type RefreshReason = 'normal' | 'force' | 'reload';

interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
}

type ImageCoords = [[number, number], [number, number], [number, number], [number, number]];

interface RenderedLayerEntry {
  url: string;
  coords: ImageCoords;
  signature: string;
}

function getViewportBounds(map: MapboxMap): ViewportBounds {
  const bounds = map.getBounds();
  if (!bounds) {
    return {
      north: 0,
      south: 0,
      east: 0,
      west: 0,
      zoom: map.getZoom(),
    };
  }
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

function selectionFromState(state: WeatherOverlayState): WeatherSelection {
  if (state.tab === 'trends') {
    const monthIso = state.date.slice(0, 7);
    return { mode: 'trends', key: `trends:${monthIso}`, monthIso };
  }

  const forecast = clampForecastSelection({
    date: state.date,
    time: state.time,
    forecastDay: state.forecastDay,
  });
  return {
    mode: 'forecast',
    key: `forecast:${forecast.date}T${forecast.time}`,
    forecastIso: `${forecast.date}T${forecast.time}`,
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
  void url;
}

function coordsEqual(left: ImageCoords, right: ImageCoords): boolean {
  return left.every((point, index) => point[0] === right[index]?.[0] && point[1] === right[index]?.[1]);
}

// Fast FNV-1a 32-bit hash. ~50-100x cheaper than JSON.stringify on hot paths.
function hashStr(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function paletteSignature(state: WeatherOverlayState, key: WeatherOverlayMetric): string {
  const palette = state.palettes?.[key];
  if (!palette) return '0';
  let h = hashStr(`${palette.scaleSetting ?? ''}`);
  const bands = palette.bands;
  if (bands) {
    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      h = hashStr(`|${band.color}|${band.minValue}|${band.maxValue}`, h);
    }
  }
  return h.toString(36);
}

async function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return canvas.toDataURL('image/png');
  return URL.createObjectURL(blob);
}

function renderSize(map: MapboxMap): { width: number; height: number } {
  const canvas = map.getCanvas();
  const width = canvas.width || canvas.clientWidth || RENDER_MIN;
  const height = canvas.height || canvas.clientHeight || RENDER_MIN;
  const aspect = width / Math.max(1, height);
  const zoom = map.getZoom();
  const scale = zoom >= 10 ? 1 : zoom >= 8 ? 0.9 : zoom >= 6 ? 0.8 : 0.7;
  const targetWidth = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(width * scale)));
  const targetHeight = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(targetWidth / aspect)));
  return { width: targetWidth, height: targetHeight };
}

function paletteOpacity(state: WeatherOverlayState, key: WeatherOverlayMetric): number {
  const opacity = state.palettes?.[key]?.opacity ?? 100;
  return Math.max(0, Math.min(1, opacity / 100));
}

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

    const setVisibility = (key: WeatherOverlayMetric, visible: boolean) => {
      try {
        if (map.getLayer(layerId(key))) {
          map.setLayoutProperty(layerId(key), 'visibility', visible ? 'visible' : 'none');
        }
      } catch {
        /* no-op */
      }
    };

    const setLayerOpacity = (key: WeatherOverlayMetric) => {
      try {
        if (map.getLayer(layerId(key))) {
          map.setPaintProperty(layerId(key), 'raster-opacity', paletteOpacity(stateRef.current, key));
        }
      } catch {
        /* no-op */
      }
    };

    const hideAll = () => {
      for (const key of SUPPORTED_KEYS) setVisibility(key, false);
      publishStatus(null);
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
      setLayerOpacity(key);
      setVisibility(key, true);
    };

    const renderFromData = async (dataset: WeatherGridDataset | null, progressBase = 76) => {
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
      const activeLayerMap = new Map(activeLayers.map((layer) => [layer.key, layer] as const));
      const renderableCount = Math.max(1, activeLayers.length);
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
          ensureLayer(key, rendered.url, rendered.coords);
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
        ensureLayer(key, url, coords);
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
    };

    const refresh = async (reason: RefreshReason) => {
      const nextState = stateRef.current;
      const activeLayers = activeRenderableLayers(nextState);
      if (!nextState.enabled || activeLayers.length === 0) {
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
      const currentDataset = dataRef.current;
      const sameSelection = currentDataset?.selectionKey === selection.key;
      const reusableGrid = currentDataset
        ? weatherGridSupportsViewport(currentDataset.grid, viewport, selection.mode)
        : false;

      if (!explicitReload && currentDataset && sameSelection && reusableGrid) {
        lastViewportRef.current = viewport;
        await renderFromData(currentDataset, 78);
        return;
      }

      if (
        !explicitReload
        &&
        !force
        && sameSelection
        && Date.now() - lastFetchTimeRef.current < MIN_FETCH_INTERVAL_MS
        && currentDataset
        && containsBounds(currentDataset.grid.bounds, viewport)
        && weatherGridSupportsViewport(currentDataset.grid, viewport, selection.mode)
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
        const grid = buildWeatherGrid(map, selection.mode);
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
          selectionKey: selection.key,
          grid,
          samples,
          fetchedAt: Date.now(),
        };
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
      if (!dataRef.current) scheduleRefresh('force');
    };

    hideAllRef.current = hideAll;
    scheduleRefreshRef.current = scheduleRefresh;

    map.on('moveend', onMoveEnd);
    map.on('zoomend', onZoomEnd);
    map.on('style.load', onStyleLoad);

    return () => {
      map.off('moveend', onMoveEnd);
      map.off('zoomend', onZoomEnd);
      map.off('style.load', onStyleLoad);
      scheduleRefreshRef.current = null;
      hideAllRef.current = null;
      abortRef.current?.abort();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
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
          const opacity = state.palettes?.[layer.key]?.opacity ?? 100;
          map.setPaintProperty(layerId(layer.key), 'raster-opacity', Math.max(0, Math.min(1, opacity / 100)));
        }
      } catch {
        /* layer may not exist yet */
      }
    }
  }, [map, isMapLoaded, activeLayers, opacityKey, state.palettes]);
}