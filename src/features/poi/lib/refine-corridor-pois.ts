// ─────────────────────────────────────────────────────────────────────
// POI corridor refinement — multi-stage pipeline
// ─────────────────────────────────────────────────────────────────────

import type { GpxRoute, PoiCategory, PoiFeature } from '../types';
import { evaluateOpeningHours } from './refinePoiOpeningHours';
import {
  projectPoiOntoRoute,
  projectRoutePoints,
  scorePoiFeature,
  PROXIMITY_FULL_FALLOFF_M,
  type ProjectedPoi,
} from './refinePoiProjection';
import {
  buildPoiClusters,
  capPoisPerCategory,
  DEFAULT_CLUSTER_LATERAL_M,
  DEFAULT_CLUSTER_RADIUS_M,
} from './refinePoiClustering';

export interface RefinementOptions {
  maxPerCategoryPerKm: number;
  windowM?: number;
  etaSecByPoint?: readonly number[];
  startTimeMs?: number;
  timezoneOffsetMin?: number;
  minSpacingSecByCategory?: Partial<Record<PoiCategory, number>>;
  clusterRadiusM?: number;
  clusterMaxLateralM?: number;
  maxHotelsPerNight?: number;
  openingToleranceMin?: number;
  maxLateralDistanceM?: number;
  maxLateralDistanceByCategory?: Partial<Record<PoiCategory, number>>;
}

/**
 * Raffine les points d'intérêt le long d'un corridor d'itinéraire en appliquant
 * projection, score de proximité/métadonnées, filtrage horaire, bonus de grappe et limitation de densité.
 */
export function refinePoiFeaturesAlongRoute(
  features: PoiFeature[],
  routePoints: GpxRoute['points'],
  options: RefinementOptions,
): PoiFeature[] {
  const maxPerKm = Math.max(0, Math.floor(options.maxPerCategoryPerKm));
  if (features.length <= 1 || routePoints.length < 2 || maxPerKm <= 0) {
    return features;
  }

  const windowM = Math.max(250, options.windowM ?? 1_000);
  const clusterRadiusM = Math.max(20, options.clusterRadiusM ?? DEFAULT_CLUSTER_RADIUS_M);
  const clusterMaxLateralM = Math.max(20, options.clusterMaxLateralM ?? DEFAULT_CLUSTER_LATERAL_M);
  const openingToleranceMin = Math.max(0, options.openingToleranceMin ?? 30);
  const maxLateralDistanceM = Math.max(
    50,
    options.maxLateralDistanceM ?? PROXIMITY_FULL_FALLOFF_M,
  );

  const projectedRoute = projectRoutePoints(routePoints);
  const projectedPois: ProjectedPoi[] = [];

  for (const feature of features) {
    const { progressM, lateralDistanceM, etaSec } = projectPoiOntoRoute(
      feature,
      projectedRoute,
      options.etaSecByPoint,
    );

    const categoryMaxLateral = options.maxLateralDistanceByCategory?.[feature.category] ?? maxLateralDistanceM;
    if (lateralDistanceM > categoryMaxLateral) continue;

    const arrivalTimeMs = options.startTimeMs != null && etaSec != null
      ? options.startTimeMs + etaSec * 1000
      : null;

    const openStatus = evaluateOpeningHours(
      feature.tags?.opening_hours,
      arrivalTimeMs,
      options.timezoneOffsetMin ?? 0,
      openingToleranceMin,
    );

    const baseScore = scorePoiFeature(feature, lateralDistanceM);

    projectedPois.push({
      feature,
      progressM,
      lateralDistanceM,
      etaSec,
      baseScore,
      score: baseScore,
      openStatus,
      clusterId: 0,
    });
  }

  buildPoiClusters(projectedPois, clusterRadiusM, clusterMaxLateralM);

  const categories = Array.from(new Set(projectedPois.map((p) => p.feature.category)));
  const refinedFeatures: PoiFeature[] = [];

  for (const category of categories) {
    const selected = capPoisPerCategory(
      category,
      projectedPois,
      maxPerKm,
      windowM,
      options.minSpacingSecByCategory?.[category],
      options.maxHotelsPerNight,
      options.startTimeMs,
      options.timezoneOffsetMin,
    );
    refinedFeatures.push(...selected);
  }

  const selectedSet = new Set(refinedFeatures.map((f) => f.id));
  return features.filter((f) => selectedSet.has(f.id));
}