/**
 * BRouter HTTP client.
 *
 * Talks to the self-hosted BRouter standalone server (Azure VPS,
 * v1.7.4). The base URL is configured through `VITE_BROUTER_URL`
 * (e.g. `http://20.123.45.67` if proxied by nginx on port 80, or
 * `http://20.123.45.67:17777` if BRouter is exposed directly).
 *
 * BRouter standalone exposes a single endpoint:
 *   GET /brouter?lonlats=lon1,lat1|lon2,lat2|...&profile=<id>
 *       &alternativeidx=0&format=geojson
 *
 * It returns a GeoJSON FeatureCollection with one LineString feature
 * whose `properties` contain summary fields (`track-length`,
 * `total-time`, `filtered ascend`, …, all stringified).
 */

export interface BrouterPoint {
  lat: number;
  lon: number;
}

export interface BrouterRoute {
  /** Decoded GeoJSON LineString coordinates ([lon, lat] pairs). */
  coordinates: [number, number][];
  /** Total length in metres. */
  distanceM: number;
  /** Total duration in seconds. */
  durationS: number;
  /** Cumulative ascent in metres (filtered, BRouter convention). */
  ascentM: number;
  /** Cumulative descent in metres (filtered). */
  descentM: number;
  /** Raw FeatureCollection — handy for debugging or richer rendering. */
  raw: GeoJSON.FeatureCollection;
}

export interface BrouterRequest {
  start: BrouterPoint;
  end: BrouterPoint;
  /** Optional intermediate via-points. */
  via?: BrouterPoint[];
  /** BRouter profile id. Must exist in `profiles2/` on the server. */
  profile?: string;
  /** Alternative index (0..3). Defaults to 0. */
  alternativeIdx?: 0 | 1 | 2 | 3;
  signal?: AbortSignal;
}

const DEFAULT_PROFILE = 'trekking';

/**
 * Resolve the URL we should hit:
 *  - In production we go through `/api/brouter` (Vercel serverless
 *    function that proxies the VPS over HTTPS, hiding the IP).
 *  - For local dev or testing you can override with `VITE_BROUTER_URL`
 *    pointing directly at the VPS (e.g. `http://135.116.81.157`).
 *    In that case we still append `/brouter` to the path.
 */
function resolveEndpoint(): { base: string; appendBrouter: boolean } {
  const raw = (import.meta.env.VITE_BROUTER_URL as string | undefined)?.trim();
  if (raw && raw.length > 0) {
    return { base: raw.replace(/\/+$/, ''), appendBrouter: true };
  }
  return { base: '/api/brouter', appendBrouter: false };
}

function formatLonlats(points: BrouterPoint[]): string {
  return points
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
    .join('|');
}

/**
 * Map an internal RedView profile id (from `DEFAULT_PROFILES`) to a
 * BRouter profile name shipped under `/home/azureuser/brouter/profiles2/`.
 *
 * Anything unknown falls back to `trekking`, the safest gravel/road mix.
 */
export function panelProfileToBrouter(panelProfileId: string): string {
  switch (panelProfileId) {
    case 'gravel-default':
      return 'trekking';
    case 'road':
      return 'fastbike';
    case 'mtb':
      return 'mtb';
    case 'touring':
      return 'trekking';
    case 'custom':
      return 'trekking';
    default:
      return DEFAULT_PROFILE;
  }
}

interface BrouterFeatureProps {
  'track-length'?: string;
  'total-time'?: string;
  'filtered ascend'?: string;
  'plain-ascend'?: string;
  // BRouter doesn't expose descent explicitly; we derive it from ascent
  // + altitudeDiff at endpoints, but the GeoJSON ships raw values too.
  [k: string]: unknown;
}

function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Build the URL but do not fetch — useful for tests/logging. */
export function buildBrouterUrl(req: BrouterRequest): string {
  const { base, appendBrouter } = resolveEndpoint();
  const points: BrouterPoint[] = [req.start, ...(req.via ?? []), req.end];
  const params = new URLSearchParams({
    lonlats: formatLonlats(points),
    profile: req.profile ?? DEFAULT_PROFILE,
    alternativeidx: String(req.alternativeIdx ?? 0),
    format: 'geojson',
  });
  return `${base}${appendBrouter ? '/brouter' : ''}?${params.toString()}`;
}

/**
 * Fetch a route from BRouter. Throws on network/HTTP errors and on
 * BRouter-side errors (which are returned as plain-text 200 responses
 * starting with `"error"` — we detect them via Content-Type).
 */
export async function fetchBrouterRoute(
  req: BrouterRequest,
): Promise<BrouterRoute> {
  const url = buildBrouterUrl(req);
  const res = await fetch(url, {
    method: 'GET',
    signal: req.signal,
    headers: { Accept: 'application/json,application/geo+json,text/plain' },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `BRouter HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text();

  // BRouter returns errors as `text/plain` bodies starting with "error" or
  // "no track"; success responses are JSON.
  if (!contentType.includes('json') || body.trim().startsWith('error')) {
    throw new Error(`BRouter: ${body.trim().slice(0, 300)}`);
  }

  let json: GeoJSON.FeatureCollection;
  try {
    json = JSON.parse(body) as GeoJSON.FeatureCollection;
  } catch (e) {
    throw new Error(
      `BRouter: réponse invalide (${(e as Error).message}). Début: ${body.slice(0, 120)}`,
    );
  }

  const feature = json.features?.[0];
  if (!feature || feature.geometry?.type !== 'LineString') {
    throw new Error('BRouter: aucune trace renvoyée pour ces points.');
  }

  const coords = feature.geometry.coordinates as [number, number][];
  const props = (feature.properties ?? {}) as BrouterFeatureProps;

  return {
    coordinates: coords,
    distanceM: num(props['track-length']),
    durationS: num(props['total-time']),
    ascentM: num(props['filtered ascend']),
    descentM: num(props['plain-ascend']) - num(props['filtered ascend']),
    raw: json,
  };
}
