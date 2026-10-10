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
  routeDistancesM,
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
;
export {
  
  
  
  
  
  
  
  
  simplifyPointsByQuality,
} from './simplify-route';
;