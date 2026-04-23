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
  const base =
    upstream !== ''
      ? upstream.replace(/\/+$/, '')
      : isClimate
      ? CLIMATE_FALLBACK
      : FORECAST_FALLBACK;

  const target = `${base}${pathAndQuery}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    const body = await upstreamRes.arrayBuffer();

    res.status(upstreamRes.status);
    const contentType = upstreamRes.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    // Browser cache: 5 min fresh, 10 min stale-while-revalidate
    res.setHeader(
      'Cache-Control',
      'public, max-age=300, stale-while-revalidate=600',
    );
    return res.send(Buffer.from(body));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: 'Upstream fetch failed', detail: msg });
  } finally {
    clearTimeout(timer);
  }
}
