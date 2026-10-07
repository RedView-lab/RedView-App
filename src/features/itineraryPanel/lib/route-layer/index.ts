/**
 * Public route-layer barrel.
 */

export {
  ANALYSIS_HOVER_SOURCE_ID,
  
  
  
  
  ROUTE_HOVER_PREVIEW_SOURCE_ID,
} from './constants';

export type {
  
  RouteLayerPoint,
  RouteSlopeBand,
} from './routeStyle';

export { getRouteElevationContext } from './routeElevation';

export {
  hasRouteLayer,
  
  listMountedRouteIds,
  removeAllRouteLayers,
  removeRouteLayer,
  
  setRouteLayerVisibility,
  stackActiveRouteOnTop,
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
  
  isAnalysisFlyoverRouteMounted,
  setAnalysisFlyoverOpacity,
  setAnalysisFlyoverProgress,
  setAnalysisFlyoverRoute,
  
  setAnalysisSelectedSegment,
  setForbiddenZoneDraft,
  setForbiddenZones,
  
  setRouteHoverPreview,
} from './mapOverlays';
