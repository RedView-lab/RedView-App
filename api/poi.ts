/**
 * Vercel serverless proxy → RedView POI server (DigitalOcean droplet).
 *
 * Deux endpoints muxés via `?op=` :
 *
 *   GET  /api/poi?op=bbox&categories=…&south=…&west=…&north=…&east=…
 *        [&limit=…&level=…&per_cell=…]
 *        → forwarde vers `${POI_UPSTREAM}/bbox?...`
 *        (`level` = échantillonnage spatial par cellule de tuile XYZ)
 *
 *   POST /api/poi?op=corridor
 *        Content-Type: application/json
 *        body = { points:[[lat,lon],...], radiusM, categories:string[] }
 *        → forwarde vers `${POI_UPSTREAM}/corridor`
 *
 * Pourquoi un proxy ?
 *   - Vercel sert en HTTPS ; appeler `http://<vps-ip>` depuis le browser
 *     déclencherait un mixed-content block + CORS.
 *   - Avec ce proxy :
 *       • le browser reste same-origin (`/api/poi`),
 *       • l'IP VPS reste cachée dans `POI_UPSTREAM` (env serveur),
 *       • Vercel met en cache les bbox identiques à l'edge.
 *
 * Variable d'env requise :
 *   POI_UPSTREAM=http://<DROPLET_IP>/poi
 */
import type { ApiRequest, ApiResponse } from './_lib/types.js';

const REQUEST_TIMEOUT_MS = 28_000; // Vercel hobby cap = 30 s
const MAX_BODY_BYTES = 512_000; // aligné sur bodyLimit du poi-server (512 Ko)

const ALLOWED_BBOX_PARAMS = new Set([
  'categories', 'south', 'west', 'north', 'east', 'limit', 'level', 'per_cell',
]);

export default async function handler(
  req: ApiRequest,
  res: ApiResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  const upstream = (process.env.POI_UPSTREAM ?? '').trim() || 'http://localhost:17778';
  const base = upstream.replace(/\/+$/, '');

  const rawOp = req.query.op;
  if (rawOp !== undefined && typeof rawOp !== 'string') {
    return res.status(400).json({ error: 'invalid op (expected a single string)' });
  }
  const op = rawOp?.toLowerCase();

  if (req.method === 'GET' && op === 'bbox') {
    return handleBbox(req, res, base);
  }
  if (req.method === 'POST' && op === 'corridor') {
    return handleCorridor(req, res, base);
  }
  if (req.method === 'GET' && op === 'health') {
    return forwardSimple(`${base}/health`, res, 'public, max-age=60');
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(400).json({ error: 'unknown op (expected bbox|corridor|health)' });
}

async function handleBbox(
  req: ApiRequest,
  res: ApiResponse,
  base: string,
) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (!ALLOWED_BBOX_PARAMS.has(k)) continue;
    if (Array.isArray(v)) params.set(k, v[0] ?? '');
    else if (typeof v === 'string') params.set(k, v);
  }
  
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${base}/bbox?${params.toString()}`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RedView/1.0 (+https://redview.tech)',
      },
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      console.warn(`[api/poi] Upstream returned HTTP ${upstream.status}`);
      return sendUpstreamFailure(res, upstream);
    }
    const data = await upstream.json().catch(() => null);
    if (!data || !Array.isArray(data.features)) {
      return sendProxyError(res, 502, 'POI upstream returned an invalid response');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (err) {
    clearTimeout(timer);
    console.warn('[api/poi] Upstream fetch error (is POI server running on 17778?):', err instanceof Error ? err.message : err);
    return sendProxyError(res, 502, isAbortError(err) ? 'POI upstream timeout' : 'POI upstream error');
  }
}

async function handleCorridor(
  req: ApiRequest,
  res: ApiResponse,
  base: string,
) {
  const rawBody = await readBody(req);
  if (rawBody.length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: `body too large (>${MAX_BODY_BYTES})` });
  }

  let parsedBody: unknown;
  try {
    parsedBody = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  const corridor = validateCorridorBody(parsedBody);
  if (!corridor.ok) {
    return res.status(400).json({ error: corridor.error });
  }
  // Ré-sérialisation d'un objet propre : aucun champ client arbitraire
  // n'atteint le serveur POI.
  const body = JSON.stringify(corridor.value);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${base}/corridor`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'RedView/1.0 (+https://redview.tech)',
      },
      body,
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      console.warn(`[api/poi] Upstream corridor returned HTTP ${upstream.status}`);
      return sendUpstreamFailure(res, upstream);
    }
    const data = await upstream.json().catch(() => null);
    if (!data || !Array.isArray(data.features)) {
      return sendProxyError(res, 502, 'POI upstream returned an invalid response');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (err) {
    clearTimeout(timer);
    console.warn('[api/poi] Upstream corridor fetch error:', err instanceof Error ? err.message : err);
    return sendProxyError(res, 502, isAbortError(err) ? 'POI upstream timeout' : 'POI upstream error');
  }
}

/* ------------------------------------------------------------------ */
/* Erreurs amont                                                        */
/* ------------------------------------------------------------------ */

// Un échec amont ne doit JAMAIS ressembler à « 200 + 0 POI » : le client ne
// pourrait pas le distinguer d'un corridor réellement vide et effacerait les
// POI déjà trouvés. 413 (corridor trop large) est relayé tel quel, toute
// autre erreur amont devient 502. Jamais mis en cache.

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'AbortError';
}

function sendProxyError(res: ApiResponse, status: number, error: string) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ error });
}

async function sendUpstreamFailure(res: ApiResponse, upstream: Response) {
  if (upstream.status === 413) {
    let message = 'Corridor too large';
    try {
      const body = (await upstream.json()) as { error?: unknown; message?: unknown };
      const raw = typeof body.error === 'string' ? body.error : body.message;
      if (typeof raw === 'string' && raw.trim()) message = raw.trim().slice(0, 300);
    } catch {
      /* corps non JSON : message par défaut */
    }
    return sendProxyError(res, 413, message);
  }
  return sendProxyError(res, 502, `POI upstream HTTP ${upstream.status}`);
}

async function forwardSimple(url: string, res: ApiResponse, cacheControl: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RedView/1.0 (+https://redview.tech)',
      },
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    return res.status(upstream.status).send(text);
  } catch (err) {
    clearTimeout(timer);
    const isAbort = isAbortError(err);
    if (!isAbort) console.warn('[api/poi] forwardSimple upstream error:', err);
    return res.status(502).json({
      error: isAbort ? 'POI upstream timeout' : 'POI upstream error',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Validation du corps `corridor`                                       */
/* ------------------------------------------------------------------ */

interface CorridorBody {
  points: [number, number][];
  radiusM: number;
  categories: string[];
}

const CORRIDOR_MIN_POINTS = 2;
const CORRIDOR_MAX_POINTS = 10_000;
const CORRIDOR_MIN_RADIUS_M = 1;
const CORRIDOR_MAX_RADIUS_M = 10_000;
const CORRIDOR_MAX_CATEGORIES = 64;
const CORRIDOR_MAX_CATEGORY_CHARS = 64;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateCorridorBody(
  input: unknown,
): { ok: true; value: CorridorBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const raw = input as { points?: unknown; radiusM?: unknown; categories?: unknown };

  if (
    !Array.isArray(raw.points) ||
    raw.points.length < CORRIDOR_MIN_POINTS ||
    raw.points.length > CORRIDOR_MAX_POINTS
  ) {
    return {
      ok: false,
      error: `points must be an array of ${CORRIDOR_MIN_POINTS}..${CORRIDOR_MAX_POINTS} [lat, lon] pairs`,
    };
  }
  const points: [number, number][] = [];
  for (const point of raw.points) {
    if (!Array.isArray(point) || point.length !== 2) {
      return { ok: false, error: 'each point must be a [lat, lon] pair' };
    }
    const [lat, lon] = point as unknown[];
    if (
      !isFiniteNumber(lat) || !isFiniteNumber(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180
    ) {
      return { ok: false, error: 'each point must be a finite [lat, lon] within range' };
    }
    points.push([lat, lon]);
  }

  if (
    !isFiniteNumber(raw.radiusM) ||
    raw.radiusM < CORRIDOR_MIN_RADIUS_M ||
    raw.radiusM > CORRIDOR_MAX_RADIUS_M
  ) {
    return {
      ok: false,
      error: `radiusM must be a finite number in [${CORRIDOR_MIN_RADIUS_M}, ${CORRIDOR_MAX_RADIUS_M}]`,
    };
  }

  if (!Array.isArray(raw.categories) || raw.categories.length > CORRIDOR_MAX_CATEGORIES) {
    return {
      ok: false,
      error: `categories must be an array of at most ${CORRIDOR_MAX_CATEGORIES} strings`,
    };
  }
  const categories: string[] = [];
  for (const category of raw.categories) {
    if (typeof category !== 'string' || category.length > CORRIDOR_MAX_CATEGORY_CHARS) {
      return {
        ok: false,
        error: `each category must be a string of at most ${CORRIDOR_MAX_CATEGORY_CHARS} chars`,
      };
    }
    categories.push(category);
  }

  return { ok: true, value: { points, radiusM: raw.radiusM, categories } };
}

async function readBody(req: ApiRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}
