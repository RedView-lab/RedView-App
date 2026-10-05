import type { Map as MapboxMap, MapboxGeoJSONFeature, PointLike } from 'mapbox-gl';
import { POI_LABELS, type PoiCategory } from '@/features/poi/types';
import type { MapContextMenuPoint } from './types';

export const FEATURE_CATEGORY_LABELS: Record<string, string> = {
  // Toutes les catégories POI indexées par le serveur, plus les couches
  // Mapbox natives que le menu contextuel sait nommer.
  ...POI_LABELS,
  address: 'Adresse',
  place: 'Lieu',
  poi: 'POI',
  road: 'Route',
};

export const SURFACE_LABELS: Record<string, string> = {
  asphalt: 'Bitume',
  asphalted: 'Bitume',
  chipseal: 'Bitume',
  cobblestone: 'Pavés',
  compacted: 'Compacté',
  concrete: 'Béton',
  dirt: 'Terre',
  fine_gravel: 'Gravier fin',
  grass: 'Herbe',
  gravel: 'Gravier',
  ground: 'Terre',
  metal: 'Métal',
  paved: 'Bitume',
  paving_stones: 'Pavés',
  pebblestone: 'Galets',
  rock: 'Roche',
  sand: 'Sable',
  sett: 'Pavés',
  unpaved: 'Non revêtu',
  wood: 'Bois',
};

/** Pixels autour du clic droit qui désignent encore l'objet visé (tracé…). */
const PICK_TOLERANCE_PX = 6;
/** Plafond de l'imprécision au sol (vue très dézoomée). */
const PICK_TOLERANCE_MAX_M = 250;

/**
 * Imprécision au sol (m) d'un clic à `lat` à l'échelle de la vue : quelques
 * pixels en mètres (tuiles de 512 px, circonférence équatoriale).
 */
export function resolvePickToleranceM(map: MapboxMap, lat: number): number {
  const metersPerPixel = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return 0;
  return Math.min(PICK_TOLERANCE_MAX_M, metersPerPixel * PICK_TOLERANCE_PX);
}

/**
 * Calcule la pente en pourcentage autour d'un point géographique via le terrain Mapbox.
 */
export function sampleSlopePct(map: MapboxMap, lng: number, lat: number): number | null {
  const elevation = map.queryTerrainElevation?.([lng, lat]);
  if (!Number.isFinite(elevation)) return null;

  const baseElevation = Number(elevation);
  const sampleDistanceM = 8;
  const delta = sampleDistanceM / 111_320;
  const elevN = map.queryTerrainElevation?.([lng, lat + delta]) ?? baseElevation;
  const elevS = map.queryTerrainElevation?.([lng, lat - delta]) ?? baseElevation;
  const elevE = map.queryTerrainElevation?.([lng + delta, lat]) ?? baseElevation;
  const elevW = map.queryTerrainElevation?.([lng - delta, lat]) ?? baseElevation;
  const slopeX = Math.abs(elevE - elevW) / (2 * sampleDistanceM);
  const slopeY = Math.abs(elevN - elevS) / (2 * sampleDistanceM);
  return Math.round(Math.hypot(slopeX, slopeY) * 100);
}

export function getFeatureString(
  properties: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function humanizeToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)\p{L}/gu, (match) => match.toLocaleUpperCase('fr-FR'));
}

export function normalizeCategoryLabel(value: string | null): string | null {
  if (!value) return null;

  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized in POI_LABELS) {
    return POI_LABELS[normalized as PoiCategory];
  }

  return FEATURE_CATEGORY_LABELS[normalized] ?? humanizeToken(value);
}

export function normalizeSurfaceLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_');
  return SURFACE_LABELS[normalized] ?? humanizeToken(value);
}

export function scoreFeature(feature: MapboxGeoJSONFeature): number {
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const layerId = feature.layer?.id?.toLowerCase() ?? '';

  let score = 0;
  if (getFeatureString(properties, ['name_fr', 'name', 'name_en', 'ref'])) score += 100;
  if (getFeatureString(properties, ['category', 'class', 'subclass', 'maki', 'type', 'poi'])) score += 45;
  if (getFeatureString(properties, ['opening_hours', 'openingHours'])) score += 35;
  if (getFeatureString(properties, ['surface', 'road_surface'])) score += 25;
  if (feature.layer?.type === 'symbol') score += 10;
  if (layerId.includes('poi')) score += 24;
  if (layerId.includes('road')) score += 12;
  if (layerId.includes('place')) score += 8;
  return score;
}

/**
 * Extrait le contexte textuel (nom, catégorie, revêtement, horaires) de la carte sous le clic.
 */
export function resolvePointContext(
  map: MapboxMap,
  point: PointLike,
): Pick<MapContextMenuPoint, 'title' | 'categoryLabel' | 'surfaceLabel' | 'openingHoursLabel'> {
  const features = map
    .queryRenderedFeatures(point)
    .filter((feature) => feature.layer?.type !== 'background');

  if (features.length === 0) {
    return {
      title: null,
      categoryLabel: null,
      surfaceLabel: null,
      openingHoursLabel: null,
    };
  }

  const feature = [...features].sort((left, right) => scoreFeature(right) - scoreFeature(left))[0];
  const properties = (feature.properties ?? {}) as Record<string, unknown>;
  const name = getFeatureString(properties, ['name_fr', 'name', 'name_en', 'ref']);
  const categoryLabel = normalizeCategoryLabel(
    getFeatureString(properties, ['category', 'class', 'subclass', 'maki', 'type', 'poi']),
  );

  return {
    title: name ?? categoryLabel,
    categoryLabel,
    surfaceLabel: normalizeSurfaceLabel(getFeatureString(properties, ['surface', 'road_surface', 'piste:type'])),
    openingHoursLabel: getFeatureString(properties, ['opening_hours', 'openingHours']),
  };
}
