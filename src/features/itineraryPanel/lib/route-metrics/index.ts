export type {
  RouteElevationMetrics,
  RouteMetrics,
  RoutePointInput,
  RouteProfilePoint,
  RouteSurfaceMetrics,
} from './types';

export {
  computeRouteElevationMetrics,
  computeRouteMetricsFromBrouter,
  computeRouteSurfaceMetricsFromBrouter,
  refineMetricsWithTerrain,
} from './metrics';

export {
  extractRouteProfileFromBrouter,
  extractRouteProfileFromPoints,
  refineRouteProfileWithIgnAltimetry,
  refineRouteProfileWithTerrain,
  refineRouteProfileWithTerrainTiles,
  sampleRouteProfileWithTerrain,
} from './profile';
