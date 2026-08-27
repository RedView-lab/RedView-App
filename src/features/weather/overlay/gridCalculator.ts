import type {
  WeatherGridDefinition,
  WeatherGridPoint,
  WeatherOverlayMetric,
  WeatherSelection,
} from './types';
import {
  weatherMetricPointBudgetBoost,
  weatherResolutionDetailBoost,
  weatherTargetCellPixels,
} from './detailProfile';

export const KM_PER_DEGREE_LATITUDE = 110.574;

export const FORECAST_SPACING_TABLE: [number, number][] = [
  [3, 0.6],
  [4, 0.3],
  [5, 0.16],
  [6, 0.08],
  [7, 0.04],
  [8, 0.02],
  [9, 0.01],
  [10, 0.005],
  [11, 0.0025],
  [12, 0.00125],
];

export const TRENDS_SPACING_TABLE: [number, number][] = [
  [3, 1.0],
  [4, 0.6],
  [5, 0.32],
  [6, 0.16],
  [7, 0.08],
  [8, 0.04],
  [9, 0.02],
  [10, 0.01],
  [11, 0.005],
  [12, 0.0025],
];

export const FORECAST_RESOLUTION_KM_TABLE: [number, number][] = [
  [3, 50],
  [4, 36],
  [5, 24],
  [6, 16],
  [7, 10],
  [8, 6],
  [9, 3],
  [10, 1.5],
  [11, 0.8],
  [12, 0.4],
];

export const TRENDS_RESOLUTION_KM_TABLE: [number, number][] = [
  [3, 50],
  [4, 40],
  [5, 28],
  [6, 18],
  [7, 12],
  [8, 8],
  [9, 4],
  [10, 2],
  [11, 1],
  [12, 0.5],
];

export const FORECAST_MIN_SPACING = 0.00125;
export const TRENDS_MIN_SPACING = 0.0025;

export interface WeatherViewport {
  north: number;
  south: number;
  east: number;
  west: number;
  zoom: number;
  pixelWidth: number;
  pixelHeight: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function interpolateSpacing(zoom: number, table: [number, number][]): number {
  if (zoom <= table[0][0]) return table[0][1];

  for (let index = 1; index < table.length; index += 1) {
    const [z0, spacing0] = table[index - 1]!;
    const [z1, spacing1] = table[index]!;
    if (zoom <= z1) {
      const t = (zoom - z0) / Math.max(0.0001, z1 - z0);
      return spacing0 + t * (spacing1 - spacing0);
    }
  }

  return table[table.length - 1]![1];
}

export function quantizeSpacing(step: number, minSpacing: number): number {
  let next = Math.max(step, minSpacing);
  if (next >= 0.03125) {
    const log2 = Math.round(Math.log2(1 / next));
    next = 1 / Math.pow(2, log2);
  } else if (next >= 0.01) {
    next = Math.ceil(next / 0.005) * 0.005;
  } else {
    next = Math.ceil(next / 0.0025) * 0.0025;
  }
  return Math.max(next, minSpacing);
}

export function snapDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

export function snapUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export function paddingForZoom(mode: WeatherSelection['mode'], zoom: number): number {
  if (mode === 'forecast') {
    if (zoom >= 9) return 0.24;
    if (zoom >= 7) return 0.2;
    return 0.15;
  }
  if (zoom >= 9) return 0.12;
  if (zoom >= 7) return 0.1;
  return 0.08;
}

export function maxPointsForZoom(
  mode: WeatherSelection['mode'],
  zoom: number,
  metrics: readonly WeatherOverlayMetric[],
  pixelWidth: number,
  pixelHeight: number,
): number {
  const targetPx = weatherTargetCellPixels(mode, zoom, metrics);
  const targetCols = Math.max(2, Math.ceil(pixelWidth / Math.max(8, targetPx)) + 1);
  const targetRows = Math.max(2, Math.ceil(pixelHeight / Math.max(8, targetPx)) + 1);
  const screenBudget = Math.ceil(targetCols * targetRows * (mode === 'forecast' ? 0.48 : 0.14));
  const metricBoost = weatherMetricPointBudgetBoost(metrics);
  const rainFocusedForecast = mode === 'forecast' && metrics.includes('rain');

  if (mode === 'forecast') {
    if (rainFocusedForecast) {
      const rainScreenBudget = Math.ceil(targetCols * targetRows * 0.72);
      const base = zoom <= 4.5 ? 32_768 : zoom <= 6.5 ? 24_576 : zoom <= 8.5 ? 8_192 : 2_560;
      const hardCap = zoom <= 4.5 ? 49_152 : zoom <= 6.5 ? 32_768 : zoom <= 8.5 ? 12_288 : 4_096;
      return Math.min(hardCap, Math.max(Math.round(base * metricBoost), rainScreenBudget));
    }
    const base = zoom <= 4.5 ? 9_216 : zoom <= 6.5 ? 7_168 : zoom <= 8.5 ? 4_608 : 2_560;
    const hardCap = zoom <= 4.5 ? 18_432 : zoom <= 6.5 ? 14_336 : zoom <= 8.5 ? 8_192 : 5_120;
    return Math.min(hardCap, Math.max(Math.round(base * metricBoost), screenBudget));
  }
  const base = zoom <= 4.5 ? 320 : zoom <= 6.5 ? 256 : 200;
  const hardCap = zoom <= 4.5 ? 896 : zoom <= 6.5 ? 720 : 512;
  return Math.min(hardCap, Math.max(Math.round(base * metricBoost), screenBudget));
}

export function gridDefaultsForMode(mode: WeatherSelection['mode']): {
  spacingTable: [number, number][];
  resolutionKmTable: [number, number][];
  minSpacing: number;
} {
  return mode === 'forecast'
    ? {
        spacingTable: FORECAST_SPACING_TABLE,
        resolutionKmTable: FORECAST_RESOLUTION_KM_TABLE,
        minSpacing: FORECAST_MIN_SPACING,
      }
    : {
        spacingTable: TRENDS_SPACING_TABLE,
        resolutionKmTable: TRENDS_RESOLUTION_KM_TABLE,
        minSpacing: TRENDS_MIN_SPACING,
      };
}

export function degreeSpacingForKilometres(targetKm: number): number {
  return targetKm / KM_PER_DEGREE_LATITUDE;
}

export function buildGridEnvelope(
  viewport: WeatherViewport,
  mode: WeatherSelection['mode'],
  metrics: readonly WeatherOverlayMetric[],
): {
  bounds: [west: number, south: number, east: number, north: number];
  rows: number;
  cols: number;
  spacing: number;
} {
  const { spacingTable, resolutionKmTable, minSpacing } = gridDefaultsForMode(mode);
  const padding = paddingForZoom(mode, viewport.zoom);
  const maxPoints = maxPointsForZoom(mode, viewport.zoom, metrics, viewport.pixelWidth, viewport.pixelHeight);
  const latPad = (viewport.north - viewport.south) * padding;
  const lngPad = (viewport.east - viewport.west) * padding;
  const paddedWest = clamp(viewport.west - lngPad, -180, 180);
  const paddedEast = clamp(viewport.east + lngPad, -180, 180);
  const paddedSouth = clamp(viewport.south - latPad, -85, 85);
  const paddedNorth = clamp(viewport.north + latPad, -85, 85);

  const targetResolutionKm = interpolateSpacing(viewport.zoom, resolutionKmTable)
    * weatherResolutionDetailBoost(mode, viewport.zoom, metrics);
  const targetSpacingDegrees = quantizeSpacing(degreeSpacingForKilometres(targetResolutionKm), minSpacing);
  const targetPx = weatherTargetCellPixels(mode, viewport.zoom, metrics);
  const targetCols = Math.max(2, Math.ceil(viewport.pixelWidth / Math.max(8, targetPx)) + 1);
  const targetRows = Math.max(2, Math.ceil(viewport.pixelHeight / Math.max(8, targetPx)) + 1);
  const screenSpacingDegrees = quantizeSpacing(
    Math.min(
      Math.abs(paddedEast - paddedWest) / Math.max(1, targetCols - 1),
      Math.abs(paddedNorth - paddedSouth) / Math.max(1, targetRows - 1),
    ),
    minSpacing,
  );
  let spacing = Math.min(
    quantizeSpacing(interpolateSpacing(viewport.zoom, spacingTable), minSpacing),
    targetSpacingDegrees,
    screenSpacingDegrees,
  );
  let rows = 0;
  let cols = 0;
  let west = paddedWest;
  let east = paddedEast;
  let south = paddedSouth;
  let north = paddedNorth;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    west = clamp(snapDown(paddedWest, spacing), -180, 180);
    east = clamp(snapUp(paddedEast, spacing), -180, 180);
    south = clamp(snapDown(paddedSouth, spacing), -85, 85);
    north = clamp(snapUp(paddedNorth, spacing), -85, 85);

    cols = Math.max(2, Math.round((east - west) / spacing) + 1);
    rows = Math.max(2, Math.round((north - south) / spacing) + 1);
    if (cols * rows <= maxPoints) break;

    const scaledSpacing = spacing * Math.sqrt((cols * rows) / maxPoints) * 1.08;
    const widenedSpacing = quantizeSpacing(scaledSpacing, minSpacing);
    spacing = widenedSpacing > spacing ? widenedSpacing : quantizeSpacing(spacing * 1.5, minSpacing);
  }

  return {
    bounds: [west, south, east, north],
    rows,
    cols,
    spacing,
  };
}

export function expandBoundsToCellEdges(
  bounds: [west: number, south: number, east: number, north: number],
  spacing: number,
): [west: number, south: number, east: number, north: number] {
  const halfSpacing = Math.max(0, spacing) * 0.5;
  return [
    clamp(bounds[0] - halfSpacing, -180, 180),
    clamp(bounds[1] - halfSpacing, -85, 85),
    clamp(bounds[2] + halfSpacing, -180, 180),
    clamp(bounds[3] + halfSpacing, -85, 85),
  ];
}

export function buildWeatherGrid(
  viewport: WeatherViewport,
  selection: WeatherSelection = { mode: 'forecast', key: 'default', forecastIso: new Date().toISOString() },
  metrics: readonly WeatherOverlayMetric[] = [],
): WeatherGridDefinition {
  const envelope = buildGridEnvelope(viewport, selection.mode, metrics);
  const [west, , , north] = envelope.bounds;
  const points: WeatherGridPoint[] = [];

  for (let r = 0; r < envelope.rows; r += 1) {
    const lat = north - r * envelope.spacing;
    for (let c = 0; c < envelope.cols; c += 1) {
      const lng = west + c * envelope.spacing;
      points.push({ lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)), row: r, col: c });
    }
  }

  return {
    bounds: expandBoundsToCellEdges(envelope.bounds, envelope.spacing),
    rows: envelope.rows,
    cols: envelope.cols,
    spacing: envelope.spacing,
    points,
  };
}

export function weatherGridSupportsViewport(
  grid: WeatherGridDefinition | null | undefined,
  viewport: WeatherViewport,
): boolean {
  if (!grid) return false;
  const [west, south, east, north] = grid.bounds;
  return viewport.west >= west && viewport.east <= east && viewport.south >= south && viewport.north <= north;
}
