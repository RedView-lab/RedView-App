import type { AnyLayer, ExpressionSpecification, VectorSourceSpecification } from 'mapbox-gl';

export const CONTOUR_SOURCE_ID = 'rv-contour-lines-source';
export const CONTOUR_CASING_LAYER_ID = 'rv-contour-lines-casing';
export const CONTOUR_LINE_LAYER_ID = 'rv-contour-lines-line';
export const CONTOUR_LAYER_PREFIX = 'rv-contour-lines-';

const CONTOUR_TILESET_URL = 'mapbox://mapbox.mapbox-terrain-v2';
const CONTOUR_SOURCE_LAYER = 'contour';

function buildContourCondition(intervalMeters: number): ExpressionSpecification {
  return [
    'all',
    ['>=', ['coalesce', ['get', 'index'], 0], 0],
    ['==', ['%', ['abs', ['coalesce', ['get', 'ele'], 0]], intervalMeters], 0],
  ] as unknown as ExpressionSpecification;
}

function buildWidthExpression(intervalMeters: number, widthStops: number[]): ExpressionSpecification {
  const condition = buildContourCondition(intervalMeters);
  return [
    'case',
    condition,
    ['interpolate', ['linear'], ['zoom'], 9, widthStops[0], 12, widthStops[1], 14, widthStops[2], 16, widthStops[3]],
    0,
  ] as unknown as ExpressionSpecification;
}

function buildOpacityExpression(intervalMeters: number, opacity: number, scale: number): ExpressionSpecification {
  const condition = buildContourCondition(intervalMeters);
  return ['case', condition, opacity * scale, 0] as unknown as ExpressionSpecification;
}

export function buildContourSource(): VectorSourceSpecification {
  return {
    type: 'vector',
    url: CONTOUR_TILESET_URL,
    minzoom: 9,
    maxzoom: 15,
  };
}

export function buildContourCasingLayer(opacity: number, intervalMeters: number): AnyLayer {
  return {
    id: CONTOUR_CASING_LAYER_ID,
    type: 'line',
    source: CONTOUR_SOURCE_ID,
    'source-layer': CONTOUR_SOURCE_LAYER,
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      visibility: 'visible',
    },
    paint: {
      'line-color': '#f6f2ea',
      'line-opacity': buildOpacityExpression(intervalMeters, opacity, 0.58),
      'line-width': buildWidthExpression(intervalMeters, [0.9, 1.2, 1.6, 2.2]),
      'line-blur': 0.08,
    },
  } as AnyLayer;
}

export function buildContourLineLayer(opacity: number, intervalMeters: number): AnyLayer {
  return {
    id: CONTOUR_LINE_LAYER_ID,
    type: 'line',
    source: CONTOUR_SOURCE_ID,
    'source-layer': CONTOUR_SOURCE_LAYER,
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      visibility: 'visible',
    },
    paint: {
      'line-color': '#8d6942',
      'line-opacity': buildOpacityExpression(intervalMeters, opacity, 0.94),
      'line-width': buildWidthExpression(intervalMeters, [0.35, 0.55, 0.82, 1.1]),
    },
  } as AnyLayer;
}

export function buildContourPaints(opacity: number, intervalMeters: number) {
  return {
    casingOpacity: buildOpacityExpression(intervalMeters, opacity, 0.58),
    casingWidth: buildWidthExpression(intervalMeters, [0.9, 1.2, 1.6, 2.2]),
    lineOpacity: buildOpacityExpression(intervalMeters, opacity, 0.94),
    lineWidth: buildWidthExpression(intervalMeters, [0.35, 0.55, 0.82, 1.1]),
  };
}