export type {
  RouteElevationMetrics,
  RouteMetrics,
  RoutePointInput,
  RouteProfilePoint,
  RouteSurfaceMetrics,
} from './route-metrics/types';

export {
  computeRouteElevationMetrics,
  computeRouteMetricsFromBrouter,
  computeRouteSurfaceMetricsFromBrouter,
  refineMetricsWithTerrain,
} from './route-metrics/metrics';

export {
  extractRouteProfileFromBrouter,
  extractRouteProfileFromPoints,
  refineRouteProfileWithTerrain,
  sampleRouteProfileWithTerrain,
} from './route-metrics/profile';
