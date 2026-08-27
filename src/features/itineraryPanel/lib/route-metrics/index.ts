export type {
  RouteElevationMetrics,
  RouteMetrics,
  RoutePointInput,
  RouteProfilePoint,
  RouteSurfaceMetrics,
  Surface,
} from './types';

export {
  computeRouteElevationMetrics,
  computeRouteMetricsFromBrouter,
  computeRouteSurfaceMetricsFromBrouter,
  computeRouteSurfaceMetricsFromPoints,
  refineMetricsWithTerrain,
} from './metrics';

export {
  extractRouteProfileFromBrouter,
  extractRouteProfileFromPoints,
  refineRouteProfileWithIgnAltimetry,
  refineRouteProfileWithTerrain,
  sampleRouteProfileWithTerrain,
} from './profile';

export {
  analyzeGpxSurfaces,
  type SurfaceAnalysisOptions,
  type SurfaceAnalysisProgress,
  type SurfaceAnalysisResult,
} from './surfaceAnalysis';

