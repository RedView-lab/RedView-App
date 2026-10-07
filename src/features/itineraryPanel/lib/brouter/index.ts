/**
 * Public barrel for the BRouter client.
 *
 * Keep imports inside the panel pointing at this module so we can
 * reorganise internals freely.
 */
export * from './types';
export {
  fetchBrouterRoute,
  
  
  
  
  
  formatBrouterErrorMessage,
  
  isBrouterRateLimitError,
} from './api';
;
export {
  COARSE_SEARCH_WEIGHT,
  
  GREEDY_COARSE_SEARCH_WEIGHT,
  
  requestBeelineKm,
  
} from './api';
export { formatForbiddenZonePolygons } from './geo';
;
;
export {
  
  checkRouteWithinFrance,
  
  
} from './geo';
export { buildBrfProfile, hashBrf,  } from './profiles';
export {
  ensureProfileUploaded,
  
  
} from './profiles';
export {
  resolveRoadTypes,
  
} from './routing';
export {
  resolveItineraryRouting,
  type ResolvedRouting,
} from './routing';
export { isClimbingMode,  } from './routing';
export {
  
  concatBrouterRoutes,
  splitRouteIntoLegs,
  type BrouterLeg,
} from './routing';
export {
  buildIslandRepairCandidates,
  isBrouterIslandError,
  
} from './routing';
export {
  
  LOCAL_EDIT_WINDOW_KM,
  TIGHT_ANCHOR_SPACING_KM,
  buildAnchoredVia,
  needsLongDistanceAnchors,
} from './routing';