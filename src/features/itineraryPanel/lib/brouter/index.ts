/**
 * Public barrel for the BRouter client.
 *
 * Keep imports inside the panel pointing at this module so we can
 * reorganise internals freely.
 */
export * from './types';
export { fetchBrouterRoute, uploadCustomProfile } from './client';
export { buildBrouterUrl, formatLonlats, resolveEndpoint } from './url';
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
