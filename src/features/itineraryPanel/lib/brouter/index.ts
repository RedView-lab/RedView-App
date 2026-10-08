/**
 * Barrel public du client BRouter.
 *
 * Garder les imports internes au panneau pointés sur ce module pour pouvoir
 * réorganiser librement l'intérieur.
 */
export * from './types';
export {
  fetchBrouterRoute,
  
  
  
  
  
  formatBrouterErrorMessage,
  
  isBrouterQueueBusy,
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