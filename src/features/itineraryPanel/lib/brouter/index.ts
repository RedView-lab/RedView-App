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
} from './api';
export { buildBrouterUrl, formatLonlats, resolveEndpoint } from './api';
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
  generateBrfFromExpertState,
  validateBrfText,
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