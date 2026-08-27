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
import type { VercelRequest, VercelResponse } from '@vercel/node';

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
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel gives us req.url like "/api/openmeteo/v1/forecast?lat=..."
  const rawUrl = req.url ?? '';
  const pathAndQuery = rawUrl.replace(/^\/api\/openmeteo/, '') || '/';

  // Only forward known Open-Meteo paths
  const isForecast = pathAndQuery.startsWith('/v1/forecast');
  const isClimate = pathAndQuery.startsWith('/v1/climate');
  if (!isForecast && !isClimate) {
    return res.status(404).json({ error: 'Unknown Open-Meteo path' });
  }

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
    const response = await fetchWithTimeout(target);
    const upstreamPayload = await readUpstreamPayload(response);
    if (response.ok && !upstreamPayload.isJson) {
      throw new Error(`${source} returned non-JSON payload${upstreamPayload.preview ? ` — ${upstreamPayload.preview}` : ''}`);
    }
    if (!response.ok) {
      throw new Error(
        `${source} returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${upstreamPayload.preview ? ` — ${upstreamPayload.preview}` : ''}`,
      );
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
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: 'Upstream fetch failed', detail: msg });
  }
}
