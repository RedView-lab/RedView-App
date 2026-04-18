/**
 * Vercel serverless proxy → BRouter standalone (Azure VPS).
 *
 * Two endpoints muxed on a single function:
 *
 *   GET  /api/brouter?lonlats=...&profile=trekking[&profile:xxx=...]
 *        → forwards the standard BRouter routing query.
 *
 *   POST /api/brouter?upload=1
 *        body = full BRF profile text (UTF-8, ≤ 100 000 chars)
 *        → uploads a custom profile, returns { profileid: "custom_<id>" }.
 *        Use that id in subsequent GETs as `profile=custom_<id>`.
 *
 * Why a proxy?
 *   - Vercel apps run over HTTPS. Calling `http://<vps-ip>` from the
 *     browser triggers a mixed-content block, and we'd also need CORS
 *     headers on every BRouter response.
 *   - With this proxy:
 *       • the browser stays same-origin (`/api/brouter`),
 *       • the VPS IP is hidden in `BROUTER_UPSTREAM` (server-only env var),
 *       • CORS is simply not an issue.
 *
 * Required env var on Vercel:
 *   BROUTER_UPSTREAM=http://135.116.81.157         (nginx on port 80)
 *   # or
 *   BROUTER_UPSTREAM=http://135.116.81.157:17777   (BRouter direct)
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const ALLOWED_PARAMS = new Set([
  'lonlats',
  'nogos',
  'polylines',
  'polygons',
  'profile',
  'alternativeidx',
  'format',
  'timode',
  'heading',
  'straight',
  'exportWaypoints',
  'exportCorrectedWaypoints',
  'trackname',
]);

const ROUTE_TIMEOUT_MS = 55_000; // Vercel hobby cap is 60 s.
const UPLOAD_TIMEOUT_MS = 15_000;
const MAX_PROFILE_BYTES = 100_000;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  const upstream = process.env.BROUTER_UPSTREAM;
  if (!upstream) {
    return res.status(500).json({
      error:
        'BROUTER_UPSTREAM env var is not set on Vercel. Configure it to e.g. http://<vps-ip>',
    });
  }
  const base = upstream.replace(/\/+$/, '');

  if (req.method === 'POST') {
    return handleProfileUpload(req, res, base);
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return handleRouteQuery(req, res, base);
}

/* ------------------------------------------------------------------ */
/* GET → /brouter routing query                                        */
/* ------------------------------------------------------------------ */

async function handleRouteQuery(
  req: VercelRequest,
  res: VercelResponse,
  base: string,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    // Allow whitelisted keys + every `profile:xxx` override (BRouter syntax
    // for tweaking individual `assign` values declared in the base profile).
    const allowed = ALLOWED_PARAMS.has(key) || key.startsWith('profile:');
    if (!allowed) continue;
    if (Array.isArray(value)) params.set(key, value[0] ?? '');
    else if (typeof value === 'string') params.set(key, value);
  }

  if (!params.has('lonlats')) {
    return res.status(400).json({ error: 'Missing "lonlats" parameter' });
  }
  if (!params.has('format')) params.set('format', 'geojson');
  if (!params.has('profile')) params.set('profile', 'trekking');

  const url = `${base}/brouter?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json,application/geo+json,text/plain' },
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort
        ? `BRouter upstream timeout after ${ROUTE_TIMEOUT_MS}ms`
        : `BRouter upstream unreachable: ${(err as Error).message}`,
    });
  }
  clearTimeout(timer);

  const body = await upstreamRes.text();
  const contentType =
    upstreamRes.headers.get('content-type') ?? 'application/json';

  // BRouter returns plain-text "error: ..." with HTTP 200 on routing
  // failures. Surface them as 422 so the client can react.
  const looksLikeError =
    !contentType.includes('json') ||
    body.trimStart().toLowerCase().startsWith('error');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  if (looksLikeError) {
    // Surface upstream error text in a custom header too, in case the
    // body is consumed/filtered on the way back to the browser (some
    // CDNs strip plain-text 422 bodies). Truncate to keep headers small.
    res.setHeader(
      'x-brouter-upstream-error',
      body.replace(/[\r\n]+/g, ' ').slice(0, 400),
    );
  }
  return res.status(looksLikeError ? 422 : upstreamRes.status).send(body);
}

/* ------------------------------------------------------------------ */
/* POST → /brouter/profile (custom BRF upload)                         */
/* ------------------------------------------------------------------ */

async function handleProfileUpload(
  req: VercelRequest,
  res: VercelResponse,
  base: string,
) {
  // Accept either raw text/plain body OR JSON { profile: "<brf>" }.
  let profileText: string | null = null;
  if (typeof req.body === 'string') {
    profileText = req.body;
  } else if (req.body && typeof req.body === 'object') {
    const maybe = (req.body as { profile?: unknown }).profile;
    if (typeof maybe === 'string') profileText = maybe;
  }

  if (!profileText || profileText.trim().length === 0) {
    return res.status(400).json({
      error:
        'POST body must contain BRF profile text (text/plain or { profile })',
    });
  }
  if (profileText.length > MAX_PROFILE_BYTES) {
    return res.status(413).json({
      error: `Profile exceeds ${MAX_PROFILE_BYTES} chars`,
    });
  }

  // Optional ?id=custom_xxx → update existing profile in place.
  const idParam = req.query.id;
  const id = typeof idParam === 'string' ? idParam : '';
  const url = id
    ? `${base}/brouter/profile/${encodeURIComponent(id)}`
    : `${base}/brouter/profile`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        Accept: 'application/json,text/plain',
      },
      body: profileText,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort
        ? `BRouter profile upload timeout after ${UPLOAD_TIMEOUT_MS}ms`
        : `BRouter upstream unreachable: ${(err as Error).message}`,
    });
  }
  clearTimeout(timer);

  const text = await upstreamRes.text();
  res.setHeader(
    'Content-Type',
    upstreamRes.headers.get('content-type') ?? 'application/json',
  );
  // Never cache profile uploads.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(upstreamRes.status).send(text);
}
