/**
 * Public barrel for the BRouter client.
 *
 * Keep imports inside the panel pointing at this module so we can
 * reorganise internals freely.
 */
export * from './types';
export {
  fetchBrouterRoute,
  uploadCustomProfile,
  fetchBrouterRouteBestOfN,
  fetchBrouterRouteBestByScore,
  fetchBrouterRouteBestWithDistanceDetours,
  fetchBrouterRouteBestWithClimbEfficiency,
  formatBrouterErrorMessage,
  BrouterRateLimitError,
  isBrouterRateLimitError,
} from './api';
export { buildBrouterUrl, formatLonlats, resolveEndpoint } from './api';
export {
  COARSE_SEARCH_WEIGHT,
  DEFAULT_SEARCH_COST_SCALE,
  effectiveSearchKm,
  requestBeelineKm,
  resolveSearchCoefficient,
} from './api';
export { formatForbiddenZonePolygons } from './geo';
export {
  panelProfileToBrouter,
  basicStateToOverrides,
  buildOverridesForItinerary,
} from './profiles';
export {
  URL_SAFE_PARAMETER_IDS,
  encodeParamValue,
  safeOverride,
  sanitizeOverrides,
} from './profiles';
export {
  isInFrance,
  checkRouteWithinFrance,
  type LatLon,
  type FranceBoundsCheck,
} from './geo';
export { buildBrfProfile, hashBrf, type BrfBuildInputs } from './profiles';
export {
  ensureProfileUploaded,
  clearProfileCache,
  profileCacheSize,
} from './profiles';
export {
  resolveRoadTypes,
  type RoadTypesResolution,
} from './routing';
export {
  resolveItineraryRouting,
  type ResolvedRouting,
} from './routing';
export { isClimbingMode, CLIMBING_SLIDER_THRESHOLD } from './routing';
export {
  MAX_BROUTER_VIA_PER_REQUEST,
  concatBrouterRoutes,
  splitRouteIntoLegs,
  type BrouterLeg,
} from './routing';
export {
  buildIslandRepairCandidates,
  isBrouterIslandError,
  type IslandRepairCandidate,
} from './routing';
export {
  ANCHOR_SECTION_KM,
  buildAnchoredVia,
  needsLongDistanceAnchors,
} from './routing';