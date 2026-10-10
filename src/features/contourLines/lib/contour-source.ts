import type { AnyLayer, ExpressionSpecification, FilterSpecification, VectorSourceSpecification } from 'mapbox-gl';

const CONTOUR_SOURCE_ID = 'rv-contour-lines-source';
const CONTOUR_CASING_LAYER_ID = 'rv-contour-lines-casing';
const CONTOUR_LINE_LAYER_ID = 'rv-contour-lines-line';
export const CONTOUR_LAYER_PREFIX = 'rv-contour-lines-';

/**
 * Courbes calculées par le Service Worker : isolignes exactes du maillage du
 * terrain HD (`public/sw-dem/processing/contours.js`), donc de niveau une fois
 * drapées. Celles de Mapbox (`mapbox-terrain-v2`) viennent d'un MNT grossier et
 * généralisé : sur le relief LiDAR (1 m, 0,40 m), elles montaient et descendaient.
 */
export const CONTOUR_HD_SOURCE_ID = 'rv-contour-lines-hd-source';
const CONTOUR_HD_CASING_LAYER_ID = 'rv-contour-lines-hd-casing';
const CONTOUR_HD_LINE_LAYER_ID = 'rv-contour-lines-hd-line';

/**
 * Zoom de carte à partir duquel les courbes HD remplacent celles de Mapbox. En
 * dessous, le relief affiché est assez grossier pour que les deux coïncident.
 */
export const CONTOUR_HD_MIN_MAP_ZOOM = 12;

/**
 * Tuiles vectorielles (512 px, la seule taille que GL JS accepte) de z12 à z17 :
 * le SW tire la tuile z/x/y du quart de la tuile DEM z − 1 que le terrain 3D
 * affiche au même zoom (`terrainDemTileZoom`) — un sommet du maillage par pixel
 * DEM —, sans construire aucune tuile DEM de plus que lui.
 */
const CONTOUR_HD_MIN_TILE_ZOOM = CONTOUR_HD_MIN_MAP_ZOOM;
const CONTOUR_HD_MAX_TILE_ZOOM = 17;

const CONTOUR_TILESET_URL = 'mapbox://mapbox.mapbox-terrain-v2';
const CONTOUR_SOURCE_LAYER = 'contour';

/** Ton du sol du fond de carte actif : la bordure est un halo découpé dedans. */
export type ContourTone = 'light' | 'dark';

/** `mapbox` : mapbox-terrain-v2 ; `hd` : courbes du MNT servies par le Service Worker. */
export type ContourVariant = 'mapbox' | 'hd';

const CONTOUR_COLORS: Record<ContourTone, { casing: string; line: string }> = {
  light: { casing: '#f6f2ea', line: '#8d6942' },
  dark: { casing: '#141a24', line: '#c9a677' },
};

const CASING_WIDTH_STOPS = [0.9, 1.2, 1.6, 2.2];
const LINE_WIDTH_STOPS = [0.35, 0.55, 0.82, 1.1];

export const CONTOUR_LAYER_IDS: Record<ContourVariant, { source: string; casing: string; line: string }> = {
  mapbox: { source: CONTOUR_SOURCE_ID, casing: CONTOUR_CASING_LAYER_ID, line: CONTOUR_LINE_LAYER_ID },
  hd: { source: CONTOUR_HD_SOURCE_ID, casing: CONTOUR_HD_CASING_LAYER_ID, line: CONTOUR_HD_LINE_LAYER_ID },
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

/** Profil DEM du maillage du terrain (`DemTileProfile` de map3d) : 1 m = `terrain`. */
export type ContourDemProfile = 'default' | 'terrain';

/**
 * Gabarit des tuiles HD : la tuile DEM lue est celle du maillage, donc du même
 * profil. URL absolue : GL JS charge les tuiles vectorielles dans son worker
 * (`blob:`), où un chemin relatif ne se résout pas (« Failed to parse URL »).
 * Même origine que la page : le Service Worker les intercepte.
 */
export function contourHdTileUrl(demProfile: ContourDemProfile): string {
  const query = demProfile === 'terrain' ? '?rv-dem-profile=terrain' : '';
  return `${window.location.origin}/contour-tiles/{z}/{x}/{y}${query}`;
}

export function buildContourSource(
  variant: ContourVariant = 'mapbox',
  demProfile: ContourDemProfile = 'default',
): VectorSourceSpecification {
  if (variant === 'hd') {
    return {
      type: 'vector',
      tiles: [contourHdTileUrl(demProfile)],
      minzoom: CONTOUR_HD_MIN_TILE_ZOOM,
      maxzoom: CONTOUR_HD_MAX_TILE_ZOOM,
    };
  }
  return {
    type: 'vector',
    url: CONTOUR_TILESET_URL,
    minzoom: 9,
    maxzoom: 15,
  };
}

function contourLayer(
  variant: ContourVariant,
  role: 'casing' | 'line',
  opacity: number,
  intervalMeters: number,
  tone: ContourTone,
): AnyLayer {
  const ids = CONTOUR_LAYER_IDS[variant];
  const casing = role === 'casing';
  return {
    id: casing ? ids.casing : ids.line,
    type: 'line',
    source: ids.source,
    'source-layer': CONTOUR_SOURCE_LAYER,
    ...(variant === 'hd' ? { minzoom: CONTOUR_HD_MIN_MAP_ZOOM } : {}),
    filter: buildContourFilter(intervalMeters),
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      visibility: 'visible',
    },
    paint: casing
      ? {
        'line-color': CONTOUR_COLORS[tone].casing,
        'line-opacity': buildOpacityExpression(opacity, 0.58),
        'line-width': buildWidthExpression(CASING_WIDTH_STOPS),
        'line-blur': 0.08,
      }
      : {
        'line-color': CONTOUR_COLORS[tone].line,
        'line-opacity': buildOpacityExpression(opacity, 0.94),
        'line-width': buildWidthExpression(LINE_WIDTH_STOPS),
      },
  } as AnyLayer;
}

export function buildContourCasingLayer(
  opacity: number,
  intervalMeters: number,
  tone: ContourTone = 'light',
  variant: ContourVariant = 'mapbox',
): AnyLayer {
  return contourLayer(variant, 'casing', opacity, intervalMeters, tone);
}

export function buildContourLineLayer(
  opacity: number,
  intervalMeters: number,
  tone: ContourTone = 'light',
  variant: ContourVariant = 'mapbox',
): AnyLayer {
  return contourLayer(variant, 'line', opacity, intervalMeters, tone);
}

export function buildContourPaints(opacity: number, intervalMeters: number, tone: ContourTone = 'light') {
  return {
    filter: buildContourFilter(intervalMeters),
    casingColor: CONTOUR_COLORS[tone].casing,
    lineColor: CONTOUR_COLORS[tone].line,
    casingOpacity: buildOpacityExpression(opacity, 0.58),
    casingWidth: buildWidthExpression(CASING_WIDTH_STOPS),
    lineOpacity: buildOpacityExpression(opacity, 0.94),
    lineWidth: buildWidthExpression(LINE_WIDTH_STOPS),
  };
}
