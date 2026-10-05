/**
 * Public route-layer barrel.
 */

export {
  ANALYSIS_HOVER_SOURCE_ID,
  FORBIDDEN_ZONE_DRAFT_SEGMENT_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HALO_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_HIT_LAYER_ID,
  FORBIDDEN_ZONE_DRAFT_VERTEX_LAYER_ID,
  ROUTE_HOVER_PREVIEW_SOURCE_ID,
} from './constants';

export type {
  RouteLayerOptions,
  RouteLayerPoint,
  RouteSlopeBand,
} from './routeStyle';

export { getRouteElevationContext } from './routeElevation';

export {
  hasRouteLayer,
  isAnyRouteOnMap,
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  raiseRouteLayer,
  setRouteLayerVisibility,
  upsertRouteLayer,
} from './itineraryLayers';

export {
  clearAnalysisFlyoverProgress,
  clearAnalysisHoverPoint,
  clearAnalysisSelectedSegment,
  clearForbiddenZoneDraft,
  clearForbiddenZones,
  clearRouteAuditFindings,
  clearRouteHoverPreview,
  fitToRoute,
  type FitToRouteOptions,
  isAnalysisFlyoverRouteMounted,
  setAnalysisFlyoverOpacity,
  setAnalysisFlyoverProgress,
  setAnalysisFlyoverRoute,
  setAnalysisHoverPoint,
  setAnalysisSelectedSegment,
  setForbiddenZoneDraft,
  setForbiddenZones,
  setRouteAuditFindings,
  setRouteHoverPreview,
} from './mapOverlays';
