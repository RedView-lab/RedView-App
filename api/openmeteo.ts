/**
 * Vercel serverless proxy → Open-Meteo upstreams.
 *
 * Why a proxy?
 *   Forecast requests still go through the self-hosted droplet because
 *   it serves HTTP only (no domain, no TLS), and Vercel apps run over
 *   HTTPS. Climate requests are forwarded to the public Open-Meteo
 *   climate API because the self-hosted VPS only mirrors short-range
 *   forecast datasets and does not have CMIP6 archives.
 *
 * Endpoints:
 *   GET /api/openmeteo/v1/forecast?latitude=...&longitude=...&...
 *   GET /api/openmeteo/v1/climate?...
 *
 * Required env var on Vercel for forecast requests:
 *   OPENMETEO_UPSTREAM=http://<DROPLET_IP>:8080
 */
import type { ApiRequest, ApiResponse } from './_lib/types.js';

const TIMEOUT_MS = 25_000;
const PUBLIC_CLIMATE_UPSTREAM = 'https://climate-api.open-meteo.com';

type WeatherSource = 'self-hosted-vps' | 'public-api';

interface UpstreamPayload {
  response: Response;
  body: Buffer;
  contentType: string;
  preview: string;
  isJson: boolean;
}

function previewText(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

async function readUpstreamPayload(response: Response): Promise<UpstreamPayload> {
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  const text = body.toString('utf-8');
  const preview = previewText(text);
  let isJson = false;

  if (text.trim()) {
    try {
      JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
  }

  return {
    response,
    body,
    contentType,
    preview,
    isJson,
  };
}

async function fetchWithTimeout(target: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(
  req: ApiRequest,
  res: ApiResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // req.url ressemble à "/api/openmeteo/v1/forecast?lat=...". On le parse
  // proprement et on n'accepte QUE les chemins exacts connus (pas de
  // préfixe, pas de "..", pas d'encodage exotique) : la cible amont est
  // reconstruite à partir d'une constante + la query string.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return res.status(404).json({ error: 'Unknown Open-Meteo path' });
  }
  const subPath = parsedUrl.pathname.replace(/^\/api\/openmeteo(?=\/|$)/, '').replace(/\/$/, '');
  const ALLOWED_PATHS: Record<string, '/v1/forecast' | '/v1/climate'> = {
    '/v1/forecast': '/v1/forecast',
    '/v1/climate': '/v1/climate',
  };
  const exactPath = Object.prototype.hasOwnProperty.call(ALLOWED_PATHS, subPath)
    ? ALLOWED_PATHS[subPath]
    : null;
  if (!exactPath) {
    return res.status(404).json({ error: 'Unknown Open-Meteo path' });
  }
  const isClimate = exactPath === '/v1/climate';
  const pathAndQuery = `${exactPath}${parsedUrl.search}`;

  let target: string;
  let source: WeatherSource;

  if (isClimate) {
    target = `${PUBLIC_CLIMATE_UPSTREAM}${pathAndQuery}`;
    source = 'public-api';
  } else {
    const upstream = (process.env.OPENMETEO_UPSTREAM ?? '').trim();
    if (!upstream) {
      target = `https://api.open-meteo.com${pathAndQuery}`;
      source = 'public-api';
    } else {
      target = `${upstream.replace(/\/+$/, '')}${pathAndQuery}`;
      source = 'self-hosted-vps';
    }
  }

  let upstreamPayload: UpstreamPayload | null = null;
  let upstreamError: unknown = null;
  try {
    upstreamPayload = await readUpstreamPayload(await fetchWithTimeout(target));
  } catch (err) {
    upstreamError = err;
  }

  // Le VPS ne miroite qu'une partie des modèles et de l'horizon : tout ce qu'il
  // ne sert pas (panne, non-JSON, 4xx) est redemandé à l'API publique.
  if (source === 'self-hosted-vps' && !isSuccess(upstreamPayload)) {
    console.warn(
      `[openmeteo-proxy] Self-hosted VPS failed (${describeFailure(upstreamPayload, upstreamError)}), falling back to public Open-Meteo API`,
    );
    target = `https://api.open-meteo.com${pathAndQuery}`;
    source = 'public-api';
    upstreamPayload = null;
    upstreamError = null;
    try {
      upstreamPayload = await readUpstreamPayload(await fetchWithTimeout(target));
    } catch (err) {
      upstreamError = err;
    }
  }

  if (!upstreamPayload || !(isSuccess(upstreamPayload) || isUpstreamClientError(upstreamPayload))) {
    console.error(`[openmeteo-proxy] upstream fetch failed: ${describeFailure(upstreamPayload, upstreamError)}`);
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }

  console.log(
    `[openmeteo-proxy] ${source === 'public-api' ? 'PUBLIC' : 'SELF-HOSTED'} ${upstreamPayload.response.status} → ${target}`,
  );

  res.status(upstreamPayload.response.status);
  const contentType = upstreamPayload.contentType || 'application/json; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  // Marker header so the browser can confirm the request was served
  // by *our* proxy (visible in DevTools → Network → Response Headers).
  res.setHeader('X-Weather-Source', source);
  if (isSuccess(upstreamPayload)) {
    // Browser cache: 5 min fresh, 10 min stale-while-revalidate
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=600',
    );
  } else {
    // 400 (horizon dépassé, paramètre refusé) ou 429 : la réponse d'Open-Meteo
    // telle quelle — le client lit la raison et applique son backoff sur 429 —,
    // jamais mise en cache (l'horizon avance chaque jour).
    res.setHeader('Cache-Control', 'no-store');
    const retryAfter = upstreamPayload.response.headers.get('retry-after');
    if (retryAfter && /^\d{1,6}$/.test(retryAfter.trim())) res.setHeader('Retry-After', retryAfter.trim());
  }
  return res.send(upstreamPayload.body);
}

function isSuccess(payload: UpstreamPayload | null): boolean {
  return !!payload && payload.response.ok && payload.isJson;
}

/** Un 4xx JSON est la réponse d'Open-Meteo à cette requête, pas une panne de l'amont. */
function isUpstreamClientError(payload: UpstreamPayload): boolean {
  const { status } = payload.response;
  return status >= 400 && status < 500 && payload.isJson;
}

function describeFailure(payload: UpstreamPayload | null, error: unknown): string {
  if (payload) {
    const { status, statusText } = payload.response;
    const kind = payload.isJson ? '' : ' (non-JSON)';
    return `${status}${statusText ? ` ${statusText}` : ''}${kind}${payload.preview ? `: ${payload.preview}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
