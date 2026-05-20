export { cleanGpxGlitches } from './clean-gpx-glitches';
export {
  normalizeImportedRoutePoints,
  buildImportedRouteMetrics,
  createImportedTimeline,
} from './imported-route';
export {
  haversineRouteDistanceM,
  cumulativeRouteLengthsM,
  projectDistanceAlongRouteM,
  projectPointAlongRoute,
  roundDistanceKm,
} from './route-distance';
export { buildRouteContentSignature } from './route-signature';
export type { RouteSignaturePoint } from './route-signature';
export { simplifyRouteToMaxPoints, simplifyPointsByQuality } from './simplify-route';