/**
 * Vercel serverless proxy → Open-Meteo self-hosted (DigitalOcean droplet).
 *
 * Why a proxy?
 *   Same reason as api/brouter.ts: the droplet serves HTTP only
 *   (no domain, no TLS), and Vercel apps run over HTTPS → mixed
 *   content would be blocked. The proxy also hides the VPS IP.
 *
 * Endpoints:
 *   GET /api/openmeteo/v1/forecast?latitude=...&longitude=...&...
 *   GET /api/openmeteo/v1/climate?...
 *
 * Required env var on Vercel:
 *   OPENMETEO_UPSTREAM=http://<DROPLET_IP>:8080
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const TIMEOUT_MS = 25_000;

// Public Open-Meteo fallback — used if OPENMETEO_UPSTREAM is empty,
// so the feature keeps working during setup / if the droplet is down.
const FORECAST_FALLBACK = 'https://api.open-meteo.com';
const CLIMATE_FALLBACK = 'https://climate-api.open-meteo.com';

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

  const upstream = (process.env.OPENMETEO_UPSTREAM ?? '').trim();
  const usingSelfHosted = upstream !== '';
  const publicBase = isClimate ? CLIMATE_FALLBACK : FORECAST_FALLBACK;
  const publicTarget = `${publicBase}${pathAndQuery}`;
  const selfHostedTarget = usingSelfHosted
    ? `${upstream.replace(/\/+$/, '')}${pathAndQuery}`
    : null;

  try {
    let upstreamPayload: UpstreamPayload | null = null;
    let source: WeatherSource = 'public-api';
    let target = publicTarget;
    let fallbackReason: string | null = null;

    if (selfHostedTarget) {
      try {
        const candidate = await fetchWithTimeout(selfHostedTarget);
        const payload = await readUpstreamPayload(candidate);
        if (candidate.ok && payload.isJson) {
          upstreamPayload = payload;
          source = 'self-hosted-vps';
          target = selfHostedTarget;
        } else if (candidate.ok) {
          fallbackReason = `self-hosted returned non-JSON payload${payload.preview ? ` — ${payload.preview}` : ''}`;
          console.warn(`[openmeteo-proxy] ${fallbackReason}; retrying public Open-Meteo`);
        } else {
          fallbackReason = `self-hosted returned ${candidate.status}${candidate.statusText ? ` ${candidate.statusText}` : ''}${payload.preview ? ` — ${payload.preview}` : ''}`;
          console.warn(`[openmeteo-proxy] ${fallbackReason}; retrying public Open-Meteo`);
        }
      } catch (err) {
        fallbackReason = err instanceof Error ? err.message : String(err);
        console.warn(`[openmeteo-proxy] self-hosted fetch failed (${fallbackReason}); retrying public Open-Meteo`);
      }
    }

    if (!upstreamPayload) {
      const publicResponse = await fetchWithTimeout(publicTarget);
      const publicPayload = await readUpstreamPayload(publicResponse);
      if (publicResponse.ok && !publicPayload.isJson) {
        throw new Error(`Public Open-Meteo returned non-JSON payload${publicPayload.preview ? ` — ${publicPayload.preview}` : ''}`);
      }
      upstreamPayload = publicPayload;
      source = 'public-api';
      target = publicTarget;
    }

    console.log(
      `[openmeteo-proxy] ${source === 'self-hosted-vps' ? 'SELF-HOSTED' : 'PUBLIC FALLBACK'} ` +
        `→ ${target}${fallbackReason ? ` (${fallbackReason})` : ''}`,
    );

    res.status(upstreamPayload.response.status);
    const contentType = upstreamPayload.contentType || 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    // Marker header so the browser can confirm the request was served
    // by *our* proxy (visible in DevTools → Network → Response Headers).
    res.setHeader('X-Weather-Source', source);
    if (fallbackReason) res.setHeader('X-Weather-Fallback-Reason', fallbackReason);
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
