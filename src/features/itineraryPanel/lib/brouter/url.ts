/**
 * URL builders for the BRouter HTTP client.
 *
 * The base URL resolution is centralised here so both `client.ts` and
 * the upload helper can share it. `VITE_BROUTER_URL` lets local dev
 * point straight at the VPS (bypassing the Vercel proxy).
 */
import {
  DEFAULT_PROFILE,
  type BrouterPoint,
  type BrouterRequest,
} from './types';
import { sanitizeOverrides } from './param-encoding';

interface ResolvedEndpoint {
  /** Base URL (no trailing slash). */
  base: string;
  /** When true, append `/brouter` for routing queries (direct VPS mode). */
  appendBrouter: boolean;
}

export function resolveEndpoint(): ResolvedEndpoint {
  const raw = (import.meta.env.VITE_BROUTER_URL as string | undefined)?.trim();
  if (raw && raw.length > 0) {
    return { base: raw.replace(/\/+$/, ''), appendBrouter: true };
  }
  return { base: '/api/brouter', appendBrouter: false };
}

export function formatLonlats(points: BrouterPoint[]): string {
  return points
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
    .join('|');
}

/** Build the routing URL — useful for tests/logging. */
export function buildBrouterUrl(req: BrouterRequest): string {
  const { base, appendBrouter } = resolveEndpoint();
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
  return `${base}${appendBrouter ? '/brouter' : ''}?${params.toString()}`;
}

/** Endpoint for the profile-upload POST. */
export function buildProfileUploadUrl(updateId?: string): string {
  const { base, appendBrouter } = resolveEndpoint();
  // Direct mode: BRouter exposes /brouter/profile (with optional /<id>).
  // Proxy mode: our /api/brouter accepts POST with optional ?id=...
  if (appendBrouter) {
    const suffix = updateId ? `/${encodeURIComponent(updateId)}` : '';
    return `${base}/brouter/profile${suffix}`;
  }
  return updateId
    ? `${base}?id=${encodeURIComponent(updateId)}`
    : base;
}
