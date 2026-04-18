/**
 * Vercel serverless proxy → BRouter standalone (Azure VPS).
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
 * Usage from the client:
 *   GET /api/brouter?lonlats=lon1,lat1|lon2,lat2&profile=trekking&format=geojson
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
  'profile:remote',
]);

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const upstream = process.env.BROUTER_UPSTREAM;
  if (!upstream) {
    return res.status(500).json({
      error:
        'BROUTER_UPSTREAM env var is not set on Vercel. Configure it to e.g. http://<vps-ip>',
    });
  }

  // Forward only the safe BRouter query parameters.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (!ALLOWED_PARAMS.has(key)) continue;
    if (Array.isArray(value)) params.set(key, value[0] ?? '');
    else if (typeof value === 'string') params.set(key, value);
  }

  if (!params.has('lonlats')) {
    return res.status(400).json({ error: 'Missing "lonlats" parameter' });
  }
  if (!params.has('format')) params.set('format', 'geojson');
  if (!params.has('profile')) params.set('profile', 'trekking');

  const url = `${upstream.replace(/\/+$/, '')}/brouter?${params.toString()}`;

  // Manual timeout: BRouter can be slow on first hit when the JVM warms up.
  const controller = new AbortController();
  const timeoutMs = 25_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        ? `BRouter upstream timeout after ${timeoutMs}ms`
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
  return res
    .status(looksLikeError ? 422 : upstreamRes.status)
    .send(body);
}
