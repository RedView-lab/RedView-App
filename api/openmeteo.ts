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

type WeatherSource = 'self-hosted-vps';

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
  if (!upstream) {
    return res.status(503).json({
      error: 'Open-Meteo VPS unavailable',
      detail: 'OPENMETEO_UPSTREAM is not configured',
    });
  }

  const selfHostedTarget = `${upstream.replace(/\/+$/, '')}${pathAndQuery}`;

  try {
    const response = await fetchWithTimeout(selfHostedTarget);
    const upstreamPayload = await readUpstreamPayload(response);
    if (response.ok && !upstreamPayload.isJson) {
      throw new Error(`self-hosted returned non-JSON payload${upstreamPayload.preview ? ` — ${upstreamPayload.preview}` : ''}`);
    }
    if (!response.ok) {
      throw new Error(
        `self-hosted returned ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${upstreamPayload.preview ? ` — ${upstreamPayload.preview}` : ''}`,
      );
    }

    const source: WeatherSource = 'self-hosted-vps';

    console.log(
      `[openmeteo-proxy] SELF-HOSTED → ${selfHostedTarget}`,
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
