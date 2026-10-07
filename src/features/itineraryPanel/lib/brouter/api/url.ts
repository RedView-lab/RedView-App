/**
 * URL builders for the BRouter HTTP client.
 *
 * Every call goes through the same-origin proxy (`api/brouter.ts`): it
 * whitelists the parameters, bounds the A* coefficient and derives the
 * uploaded profile's id from its content. The VPS answers 403 to anything
 * else.
 */
import {
  DEFAULT_PROFILE,
  type BrouterPoint,
  type BrouterRequest,
} from '../types';
import { sanitizeOverrides } from '../profiles/param-encoding';
import { observedCostScale, resolveSearchCoefficient } from './searchCoefficient';

const BROUTER_PROXY_URL = '/api/brouter';

function formatLonlats(points: BrouterPoint[]): string {
  return points
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
    .join('|');
}

/** Build the routing URL — useful for tests/logging. */
export function buildBrouterUrl(req: BrouterRequest): string {
  const points: BrouterPoint[] = [req.start, ...(req.via ?? []), req.end];
  const params = new URLSearchParams({
    lonlats: formatLonlats(points),
    profile: req.profile ?? DEFAULT_PROFILE,
    alternativeidx: String(req.alternativeIdx ?? 0),
    format: 'geojson',
  });
  if (req.polygons) params.set('polygons', req.polygons);
  if (req.nogos) params.set('nogos', req.nogos);
  if (req.overrides) {
    const safe = sanitizeOverrides(req.overrides);
    for (const [key, value] of Object.entries(safe)) {
      // Final guard: every override key must be prefixed with "profile:".
      // `sanitizeOverrides` already encoded the value and dropped unknown
      // / empty keys, so we only need the prefix here.
      const k = key.startsWith('profile:') ? key : `profile:${key}`;
      params.set(k, value);
    }
  }

  // Passe unique (pass2coefficient = -1) ; coefficient A* adapté à la distance
  // et à l'échelle de coût du profil (le proxy le borne).
  params.set('profile:pass2coefficient', '-1');
  params.set('profile:pass1coefficient', String(resolveSearchCoefficient(
    points,
    observedCostScale(req.profile) ?? req.searchCostScale,
    req.searchWeight,
  )));

  return `${BROUTER_PROXY_URL}?${params.toString()}`;
}

/** Endpoint for the profile-upload POST (the proxy derives the id from the profile). */
export function buildProfileUploadUrl(): string {
  return BROUTER_PROXY_URL;
}
