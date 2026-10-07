import type { AnyLayer, ExpressionSpecification, FilterSpecification, VectorSourceSpecification } from 'mapbox-gl';

export const CONTOUR_SOURCE_ID = 'rv-contour-lines-source';
export const CONTOUR_CASING_LAYER_ID = 'rv-contour-lines-casing';
export const CONTOUR_LINE_LAYER_ID = 'rv-contour-lines-line';
export const CONTOUR_LAYER_PREFIX = 'rv-contour-lines-';

const CONTOUR_TILESET_URL = 'mapbox://mapbox.mapbox-terrain-v2';
const CONTOUR_SOURCE_LAYER = 'contour';

/** Ground tone of the active basemap: the casing is a halo cut out of it. */
export type ContourTone = 'light' | 'dark';

const CONTOUR_COLORS: Record<ContourTone, { casing: string; line: string }> = {
  light: { casing: '#f6f2ea', line: '#8d6942' },
  dark: { casing: '#141a24', line: '#c9a677' },
};

function buildContourFilter(intervalMeters: number): FilterSpecification {
  return [
    'all',
    ['>=', ['coalesce', ['get', 'index'], 0], 0],
    ['==', ['%', ['abs', ['coalesce', ['get', 'ele'], 0]], intervalMeters], 0],
  ] as unknown as FilterSpecification;
}

function buildWidthExpression(widthStops: number[]): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    9,
    widthStops[0],
    12,
    widthStops[1],
    14,
    widthStops[2],
    16,
    widthStops[3],
  ] as unknown as ExpressionSpecification;
}

function buildOpacityExpression(opacity: number, scale: number): number {
  return opacity * scale;
}

export function buildContourSource(): VectorSourceSpecification {
  return {
    type: 'vector',
    url: CONTOUR_TILESET_URL,
    minzoom: 9,
    maxzoom: 15,
  };
}

export function buildContourCasingLayer(opacity: number, intervalMeters: number, tone: ContourTone = 'light'): AnyLayer {
  return {
    id: CONTOUR_CASING_LAYER_ID,
    type: 'line',
    source: CONTOUR_SOURCE_ID,
    'source-layer': CONTOUR_SOURCE_LAYER,
    filter: buildContourFilter(intervalMeters),
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      visibility: 'visible',
    },
    paint: {
      'line-color': CONTOUR_COLORS[tone].casing,
      'line-opacity': buildOpacityExpression(opacity, 0.58),
      'line-width': buildWidthExpression([0.9, 1.2, 1.6, 2.2]),
      'line-blur': 0.08,
    },
  } as AnyLayer;
}

export function buildContourLineLayer(opacity: number, intervalMeters: number, tone: ContourTone = 'light'): AnyLayer {
  return {
    id: CONTOUR_LINE_LAYER_ID,
    type: 'line',
    source: CONTOUR_SOURCE_ID,
    'source-layer': CONTOUR_SOURCE_LAYER,
    filter: buildContourFilter(intervalMeters),
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      visibility: 'visible',
    },
    paint: {
      'line-color': CONTOUR_COLORS[tone].line,
      'line-opacity': buildOpacityExpression(opacity, 0.94),
      'line-width': buildWidthExpression([0.35, 0.55, 0.82, 1.1]),
    },
  } as AnyLayer;
}

export function buildContourPaints(opacity: number, intervalMeters: number, tone: ContourTone = 'light') {
  return {
    filter: buildContourFilter(intervalMeters),
    casingColor: CONTOUR_COLORS[tone].casing,
    lineColor: CONTOUR_COLORS[tone].line,
    casingOpacity: buildOpacityExpression(opacity, 0.58),
    casingWidth: buildWidthExpression([0.9, 1.2, 1.6, 2.2]),
    lineOpacity: buildOpacityExpression(opacity, 0.94),
    lineWidth: buildWidthExpression([0.35, 0.55, 0.82, 1.1]),
  };
}