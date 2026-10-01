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

  try {
    let response: Response;
    let upstreamPayload: UpstreamPayload;

    try {
      response = await fetchWithTimeout(target);
      upstreamPayload = await readUpstreamPayload(response);
      if (!response.ok || !upstreamPayload.isJson) {
        throw new Error(
          `${source} returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
        );
      }
    } catch (primaryErr) {
      if (source === 'self-hosted-vps') {
        console.warn(`[openmeteo-proxy] Self-hosted VPS failed, falling back to public Open-Meteo API:`, primaryErr);
        const fallbackTarget = `https://api.open-meteo.com${pathAndQuery}`;
        target = fallbackTarget;
        source = 'public-api';
        response = await fetchWithTimeout(fallbackTarget);
        upstreamPayload = await readUpstreamPayload(response);
        if (!response.ok || !upstreamPayload.isJson) {
          throw new Error(`public-api fallback returned ${response.status}`);
        }
      } else {
        throw primaryErr;
      }
    }

    console.log(
      `[openmeteo-proxy] ${source === 'public-api' ? 'PUBLIC' : 'SELF-HOSTED'} → ${target}`,
    );

    res.status(upstreamPayload.response.status);
    const contentType = upstreamPayload.contentType || 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    // Marker header so the browser can confirm the request was served
    // by *our* proxy (visible in DevTools → Network → Response Headers).
    res.setHeader('X-Weather-Source', source);
    // Browser cache: 5 min fresh, 10 min stale-while-revalidate
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=600',
    );
    return res.send(upstreamPayload.body);
  } catch (err) {
    console.error('[openmeteo-proxy] upstream fetch failed:', err);
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
