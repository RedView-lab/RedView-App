import { useEffect, useMemo, useRef } from 'react';
import type { ImageSource, Map as MapboxMap } from 'mapbox-gl';
import type { WindGridDefinition, WindPoint, WindTimeSelection } from '../types';
import { computeWindGrid } from '../lib/wind-grid';
import { fetchWindGridData } from '../lib/open-meteo';

const SOURCE_ID = 'wind-terrain-overlay-source';
const LAYER_ID = 'wind-terrain-overlay-layer';
const MOVE_DEBOUNCE_MS = 220;
const MIN_FETCH_INTERVAL_MS = 800;
const RENDER_MIN = 320;
const RENDER_MAX = 3072;
const BOUNDS_PADDING = 0.8;
const BASE_OPACITY = 0.58;

type RefreshReason = 'normal' | 'force';
type ImageCoords = [[number, number], [number, number], [number, number], [number, number]];

interface ViewportBounds {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
}

interface WindOverlayDataset {
  selectionKey: string;
  grid: WindGridDefinition;
  points: WindPoint[];
  fetchedAt: number;
}

interface RenderedLayerEntry {
  url: string;
  coords: ImageCoords;
  signature: string;
}

const WIND_COLOR_STOPS = [
  { speedKmh: 0, color: '#2DBF8C' },
  { speedKmh: 15, color: '#2DBF8C' },
  { speedKmh: 30, color: '#FFD800' },
  { speedKmh: 50, color: '#FF8D00' },
  { speedKmh: 70, color: '#FF0D0D' },
] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function imageCoords(bounds: { west: number; south: number; east: number; north: number }): ImageCoords {
  return [
    [bounds.west, bounds.north],
    [bounds.east, bounds.north],
    [bounds.east, bounds.south],
    [bounds.west, bounds.south],
  ];
}

function coordsEqual(left: ImageCoords, right: ImageCoords): boolean {
  return left.every((point, index) => point[0] === right[index]?.[0] && point[1] === right[index]?.[1]);
}

function containsBounds(
  container: { west: number; south: number; east: number; north: number },
  viewport: ViewportBounds,
): boolean {
  return viewport.west >= container.west
    && viewport.south >= container.south
    && viewport.east <= container.east
    && viewport.north <= container.north;
}

function selectionKey(selection: WindTimeSelection): string {
  return `${selection.date}T${selection.time}`;
}

function renderSize(map: MapboxMap): { width: number; height: number } {
  const canvas = map.getCanvas();
  const width = canvas.width || canvas.clientWidth || RENDER_MIN;
  const height = canvas.height || canvas.clientHeight || RENDER_MIN;
  const aspect = width / Math.max(1, height);
  const zoom = map.getZoom();
  const baseScale = zoom >= 10 ? 1 : zoom >= 8 ? 0.9 : zoom >= 6 ? 0.8 : 0.7;
  const dezoomSuperSample = zoom < 8 ? 2 : 1;
  const targetWidth = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(width * baseScale * dezoomSuperSample)));
  const targetHeight = Math.max(RENDER_MIN, Math.min(RENDER_MAX, Math.round(targetWidth / aspect)));
  return { width: targetWidth, height: targetHeight };
}

function hexToRgb(hex: string): [number, number, number] {
  const safe = hex.replace('#', '').trim();
  return [
    Number.parseInt(safe.slice(0, 2), 16),
    Number.parseInt(safe.slice(2, 4), 16),
    Number.parseInt(safe.slice(4, 6), 16),
  ];
}

function interpolateChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * clamp(t, 0, 1));
}

function interpolateRgb(
  start: [number, number, number],
  end: [number, number, number],
  t: number,
): [number, number, number] {
  return [
    interpolateChannel(start[0], end[0], t),
    interpolateChannel(start[1], end[1], t),
    interpolateChannel(start[2], end[2], t),
  ];
}

function colorForSpeed(speedMs: number): [number, number, number, number] {
  const speedKmh = Math.max(0, speedMs * 3.6);
  const lowerIndex = WIND_COLOR_STOPS.findLastIndex((entry) => speedKmh >= entry.speedKmh);
  const lower = WIND_COLOR_STOPS[Math.max(0, lowerIndex)];
  const upper = WIND_COLOR_STOPS[Math.min(WIND_COLOR_STOPS.length - 1, Math.max(0, lowerIndex) + 1)];
  const lowerColor = hexToRgb(lower.color);
  const upperColor = hexToRgb(upper.color);
  const span = Math.max(1, upper.speedKmh - lower.speedKmh);
  const ratio = lower === upper ? 0 : (speedKmh - lower.speedKmh) / span;
  const [r, g, b] = interpolateRgb(lowerColor, upperColor, ratio);
  return [r, g, b, 255];
}

function sampleValue(values: number[], cols: number, row: number, col: number): number {
  const clampedRow = clamp(row, 0, Math.max(0, Math.floor(values.length / cols) - 1));
  const clampedCol = clamp(col, 0, cols - 1);
  return values[clampedRow * cols + clampedCol] ?? Number.NaN;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function bilinear(values: number[], grid: WindGridDefinition, xRatio: number, yRatio: number): number {
  const fx = clamp(xRatio, 0, 1) * Math.max(0, grid.cols - 1);
  const fy = clamp(yRatio, 0, 1) * Math.max(0, grid.rows - 1);
  const c0 = Math.floor(fx);
  const c1 = Math.min(grid.cols - 1, c0 + 1);
  const r0 = Math.floor(fy);
  const r1 = Math.min(grid.rows - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const top = lerp(sampleValue(values, grid.cols, r0, c0), sampleValue(values, grid.cols, r0, c1), tx);
  const bottom = lerp(sampleValue(values, grid.cols, r1, c0), sampleValue(values, grid.cols, r1, c1), tx);
  return lerp(top, bottom, ty);
}

function renderWindOverlayCanvas(
  grid: WindGridDefinition,
  points: WindPoint[],
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const speeds = points.map((point) => point.speed);
  const image = ctx.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    const yRatio = height <= 1 ? 0 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const xRatio = width <= 1 ? 0 : x / (width - 1);
      const speed = bilinear(speeds, grid, xRatio, yRatio);
      const [r, g, b, a] = colorForSpeed(Number.isFinite(speed) ? speed : 0);
      const offset = (y * width + x) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = a;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

async function canvasToObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return canvas.toDataURL('image/png');
  return URL.createObjectURL(blob);
}

export function useWindTerrainOverlay(
  map: MapboxMap | null,
  isMapLoaded: boolean,
  enabled: boolean,
  selection: WindTimeSelection,
): void {
  const stateRef = useRef({ enabled, selection });
  stateRef.current = { enabled, selection };

  const dataRef = useRef<WindOverlayDataset | null>(null);
  const lastFetchTimeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const renderedRef = useRef<RenderedLayerEntry | null>(null);
  const generationRef = useRef(0);
  const scheduleRefreshRef = useRef<((reason: RefreshReason) => void) | null>(null);
  const selectionKeyMemo = useMemo(() => selectionKey(selection), [selection.date, selection.time]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;

    let cancelled = false;

    const canMutateStyle = () => {
      if (cancelled) return false;
      try {
        return map.isStyleLoaded() && Boolean(map.getStyle());
      } catch {
        return false;
      }
    };

    const hide = () => {
      try {
        if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
      } catch {
        /* no-op */
      }
    };

    const ensureLayer = (url: string, coords: ImageCoords): boolean => {
      if (!canMutateStyle()) return false;
      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: 'image',
            url,
            coordinates: coords,
          } as never);
        }
        if (!map.getLayer(LAYER_ID)) {
          map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            slot: 'top',
            paint: {
              'raster-opacity': BASE_OPACITY,
              'raster-fade-duration': 0,
              'raster-resampling': 'linear',
            },
          } as never);
        }
        const source = map.getSource(SOURCE_ID) as ImageSource | undefined;
        source?.updateImage({ url, coordinates: coords });
        map.setLayoutProperty(LAYER_ID, 'visibility', 'visible');
        return true;
      } catch {
        return false;
      }
    };

    const renderFromData = async (dataset: WindOverlayDataset | null) => {
      if (!dataset || !stateRef.current.enabled) {
        hide();
        return;
      }
      if (!canMutateStyle()) return;

      const coords = imageCoords(dataset.grid.bounds);
      const size = renderSize(map);
      const signature = [dataset.selectionKey, dataset.fetchedAt, `${size.width}x${size.height}`].join('|');
      const rendered = renderedRef.current;
      if (rendered && rendered.signature === signature && coordsEqual(rendered.coords, coords)) {
        if (!ensureLayer(rendered.url, rendered.coords)) return;
        return;
      }

      const canvas = renderWindOverlayCanvas(dataset.grid, dataset.points, size.width, size.height);
      const url = await canvasToObjectUrl(canvas);
      if (!canMutateStyle()) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      if (!ensureLayer(url, coords)) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        return;
      }
      if (rendered?.url.startsWith('blob:')) {
        window.setTimeout(() => URL.revokeObjectURL(rendered.url), 1_000);
      }
      renderedRef.current = { url, coords, signature };
    };

    const refresh = async (reason: RefreshReason) => {
      if (!canMutateStyle()) return;

      if (!stateRef.current.enabled) {
        hide();
        return;
      }

      const viewport = getViewportBounds(map);
      const currentDataset = dataRef.current;
      const sameSelection = currentDataset?.selectionKey === selectionKey(stateRef.current.selection);

      if (
        reason === 'normal'
        && currentDataset
        && sameSelection
        && containsBounds(currentDataset.grid.bounds, viewport)
      ) {
        await renderFromData(currentDataset);
        return;
      }

      if (
        reason === 'normal'
        && sameSelection
        && Date.now() - lastFetchTimeRef.current < MIN_FETCH_INTERVAL_MS
        && currentDataset
        && containsBounds(currentDataset.grid.bounds, viewport)
      ) {
        await renderFromData(currentDataset);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const generation = ++generationRef.current;

      const latPad = (viewport.north - viewport.south) * BOUNDS_PADDING;
      const lngPad = (viewport.east - viewport.west) * BOUNDS_PADDING;
      const fetchBounds = {
        north: Math.min(90, viewport.north + latPad),
        south: Math.max(-90, viewport.south - latPad),
        east: Math.min(180, viewport.east + lngPad),
        west: Math.max(-180, viewport.west - lngPad),
      };

      try {
        const grid = computeWindGrid(fetchBounds, viewport, viewport.zoom);
        const points = await fetchWindGridData(grid, stateRef.current.selection, controller.signal);
        if (controller.signal.aborted || generation !== generationRef.current) return;
        dataRef.current = {
          selectionKey: selectionKey(stateRef.current.selection),
          grid,
          points,
          fetchedAt: Date.now(),
        };
        lastFetchTimeRef.current = Date.now();
        await renderFromData(dataRef.current);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('[wind-overlay]', error);
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
      if (!canMutateStyle()) return;
      const rendered = renderedRef.current;
      if (!stateRef.current.enabled) {
        hide();
        return;
      }
      if (rendered) ensureLayer(rendered.url, rendered.coords);
      if (!dataRef.current) scheduleRefresh('force');
    };

    scheduleRefreshRef.current = scheduleRefresh;
    map.on('moveend', onMoveEnd);
    map.on('zoomend', onZoomEnd);
    map.on('style.load', onStyleLoad);

    return () => {
      cancelled = true;
      generationRef.current += 1;
      map.off('moveend', onMoveEnd);
      map.off('zoomend', onZoomEnd);
      map.off('style.load', onStyleLoad);
      scheduleRefreshRef.current = null;
      abortRef.current?.abort();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (renderedRef.current?.url.startsWith('blob:')) URL.revokeObjectURL(renderedRef.current.url);
      renderedRef.current = null;
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        /* no-op */
      }
    };
  }, [isMapLoaded, map]);

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (!enabled) {
      try {
        if (map.getLayer(LAYER_ID)) map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
      } catch {
        /* no-op */
      }
      return;
    }
    scheduleRefreshRef.current?.('force');
  }, [enabled, isMapLoaded, map, selectionKeyMemo]);
}