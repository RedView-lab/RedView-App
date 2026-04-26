/**
 * Public barrel for the BRouter client.
 *
 * Keep imports inside the panel pointing at this module so we can
 * reorganise internals freely.
 */
export * from './types';
export { fetchBrouterRoute, uploadCustomProfile, fetchBrouterRouteBestOfN } from './client';
export { buildBrouterUrl, formatLonlats, resolveEndpoint } from './url';
export { formatForbiddenZonePolygons } from './forbidden-zones';
export {
  panelProfileToBrouter,
  basicStateToOverrides,
  buildOverridesForItinerary,
} from './profile-overrides';
export {
  URL_SAFE_PARAMETER_IDS,
  encodeParamValue,
  safeOverride,
  sanitizeOverrides,
} from './param-encoding';
export {
  generateBrfFromExpertState,
  validateBrfText,
} from './profile-template';
export {
  isInFrance,
  checkRouteWithinFrance,
  type LatLon,
  type FranceBoundsCheck,
} from './france-bounds';
export { buildBrfProfile, hashBrf, type BrfBuildInputs } from './brf-template';
export {
  ensureProfileUploaded,
  clearProfileCache,
  profileCacheSize,
} from './profile-cache';
export {
  resolveRoadTypes,
  type RoadTypesResolution,
} from './road-types-resolver';
export {
  resolveItineraryRouting,
  type ResolvedRouting,
} from './routing-resolver';
export { isClimbingMode, CLIMBING_SLIDER_THRESHOLD } from './climb-mode';