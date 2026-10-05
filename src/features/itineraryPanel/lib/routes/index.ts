export { cleanGpxGlitches } from './clean-gpx-glitches';
export {
  normalizeImportedRoutePoints,
  buildImportedRouteMetrics,
  createImportedTimeline,
  refineImportedRoutePointsWithIgnAltimetry,
} from './imported-route';
export {
  haversineRouteDistanceM,
  cumulativeRouteLengthsM,
  projectDistanceAlongRouteM,
  projectPointAlongRoute,
  projectViaPointAlongRoute,
  roundDistanceKm,
} from './route-distance';
export type { RouteDistancePoint, ProjectedRoutePoint } from './route-distance';
export {
  ROUTE_SEAM_TOLERANCE_M,
  ROUTE_SNAP_TOLERANCE_M,
  RouteSeamError,
  isRouteSeamError,
  routeSeamJoins,
} from './route-continuity';
export { buildRouteContentSignature, buildRouteGeometrySignature } from './route-signature';
export type { RouteSignaturePoint } from './route-signature';
export {
  applyGpxQuality,
  buildGpxQualityStats,
  computeGpxQualityTargetPointCount,
  resolveGpxQualityPointsPerKm,
  GPX_QUALITY_PRESET_POINTS_PER_KM,
  GPX_QUALITY_EXPERT_MIN_POINTS_PER_KM,
  GPX_QUALITY_EXPERT_MAX_POINTS_PER_KM,
  simplifyRouteToMaxPoints,
  simplifyPointsByQuality,
} from './simplify-route';
export type { GpxQualityStats } from './simplify-route';