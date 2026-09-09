/**
 * RedView Weather Proxy (Vercel Serverless & Local Dev)
 * Relays weather tiles and metadata to the self-hosted Oracle VPS.
 *
 * Endpoints:
 *   GET /api/weather/meta.json
 *   GET /api/weather/tiles/:variable/:hour.(webp|png)
 *   GET /api/weather/point?lat=...&lon=...
 *
 * Upstream env var:
 *   WEATHER_UPSTREAM=http://141.145.220.99/weather
 */
import type { ApiRequest, ApiResponse } from './_lib/types.js';
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = 15_000;
const DEFAULT_VPS_UPSTREAM = 'http://141.145.220.99/weather';

async function fetchUpstream(target: string): Promise<{ response: Response; body: Buffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { Accept: '*/*' },
      signal: controller.signal,
    });
    const arrayBuf = await response.arrayBuffer();
    return {
      response,
      body: Buffer.from(arrayBuf),
    };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawUrl = req.url ?? '';
  const subPath = rawUrl.replace(/^\/api\/weather\/?/, '') || 'meta.json';
  const upstreamBase = (process.env.WEATHER_UPSTREAM ?? DEFAULT_VPS_UPSTREAM).replace(/\/+$/, '');
  const targetUrl = `${upstreamBase}/${subPath}`;

  try {
    const { response, body } = await fetchUpstream(targetUrl);
    const upstreamContentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok || upstreamContentType.includes('text/html')) {
      throw new Error(`Upstream returned ${response.status} (${upstreamContentType || 'unknown'})`);
    }

    const contentType = response.headers.get('content-type') ||
      (subPath.endsWith('.webp') ? 'image/webp' :
       subPath.endsWith('.png') ? 'image/png' :
       'application/json; charset=utf-8');

    res.status(response.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Weather-Source', 'oracle-vps');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (subPath.includes('tiles/')) {
      res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    }

    return res.send(body);
  } catch (err) {
    // Check local fallback directory (e.g. during local dev or tests)
    const localFallbackFile = path.resolve(process.cwd(), 'dist_weather', subPath.split('?')[0]);
    if (fs.existsSync(localFallbackFile) && fs.statSync(localFallbackFile).isFile()) {
      const content = fs.readFileSync(localFallbackFile);
      const contentType =
        subPath.endsWith('.webp') ? 'image/webp' :
        subPath.endsWith('.png') ? 'image/png' :
        'application/json; charset=utf-8';

      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Weather-Source', 'local-fallback');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(content);
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[weather-proxy] upstream failed: ${msg}`);
    return res.status(502).json({
      error: 'Weather upstream unavailable',
      upstream: targetUrl,
      detail: msg,
    });
  }
}
