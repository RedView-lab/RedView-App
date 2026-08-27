/**
 * Vercel serverless proxy → RedView POI server (DigitalOcean droplet).
 *
 * Deux endpoints muxés via `?op=` :
 *
 *   GET  /api/poi?op=bbox&categories=…&south=…&west=…&north=…&east=…
 *        → forwarde vers `${POI_UPSTREAM}/bbox?...`
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
import type { VercelRequest, VercelResponse } from '@vercel/node';

const REQUEST_TIMEOUT_MS = 28_000; // Vercel hobby cap = 30 s
const MAX_BODY_BYTES = 256_000;

const ALLOWED_BBOX_PARAMS = new Set([
  'categories', 'south', 'west', 'north', 'east', 'limit',
]);

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  const upstream = (process.env.POI_UPSTREAM ?? '').trim() || 'http://localhost:17778';
  const base = upstream.replace(/\/+$/, '');

  const op = (req.query.op as string | undefined)?.toLowerCase();

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
  req: VercelRequest,
  res: VercelResponse,
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
        'User-Agent': 'RedView/1.0 (+https://redview.app)',
      },
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      console.warn(`[api/poi] Upstream returned HTTP ${upstream.status}`);
      return res.status(200).json({ features: [] });
    }
    const data = await upstream.json().catch(() => ({ features: [] }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(data.features ? data : { features: [] });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[api/poi] Upstream fetch error (is POI server running on 17778?):', err instanceof Error ? err.message : err);
    return res.status(200).json({ features: [] });
  }
}

async function handleCorridor(
  req: VercelRequest,
  res: VercelResponse,
  base: string,
) {
  const body = await readBody(req);
  if (body.length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: `body too large (>${MAX_BODY_BYTES})` });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${base}/corridor`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'RedView/1.0 (+https://redview.app)',
      },
      body,
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      console.warn(`[api/poi] Upstream corridor returned HTTP ${upstream.status}`);
      return res.status(200).json({ features: [] });
    }
    const data = await upstream.json().catch(() => ({ features: [] }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json(data.features ? data : { features: [] });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[api/poi] Upstream corridor fetch error:', err instanceof Error ? err.message : err);
    return res.status(200).json({ features: [] });
  }
}

async function forwardSimple(url: string, res: VercelResponse, cacheControl: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RedView/1.0 (+https://redview.app)',
      },
    });
    clearTimeout(timer);
    const text = await upstream.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    return res.status(upstream.status).send(text);
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    return res.status(502).json({
      error: isAbort ? 'POI upstream timeout' : `POI upstream error: ${(err as Error).message}`,
    });
  }
}

async function readBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}
