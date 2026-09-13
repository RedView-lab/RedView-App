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
const DEFAULT_VPS_UPSTREAM = process.env.WEATHER_UPSTREAM || '';

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
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, 'http://localhost');
  } catch {
    parsedUrl = new URL('/api/weather', 'http://localhost');
  }
  const subPath = parsedUrl.pathname.replace(/^\/api\/weather\/?/, '') || 'meta.json';

  if (!/^[a-zA-Z0-9_\-./]+$/.test(subPath) || subPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path parameter' });
  }

  // Live Doppler radar tile proxy (relayed from /radar-tiles/*)
  const ALLOWED_RADAR_HOSTS = new Set([
    'https://tilecache.rainviewer.com',
    'https://tilecache.rainviewer.net',
  ]);

  if (subPath.startsWith('radar-tile')) {
    try {
      const parsed = parsedUrl;
      const requestedHost = (parsed.searchParams.get('host') || '').trim();
      const host = ALLOWED_RADAR_HOSTS.has(requestedHost)
        ? requestedHost
        : 'https://tilecache.rainviewer.com';

      const rawFramePath = decodeURIComponent(parsed.searchParams.get('path') || '').trim();
      if (!rawFramePath || !/^\/?[a-zA-Z0-9_\-\/]+$/.test(rawFramePath)) {
        res.status(400);
        return res.json({ error: 'Invalid frame path parameter' });
      }

      const match = parsed.pathname.match(/(?:\/radar-tiles?\/|\/)(\d+)\/(\d+)\/(\d+)/);
      if (match) {
        const [, z, x, y] = match;
        const cleanPath = rawFramePath.startsWith('/') ? rawFramePath : `/${rawFramePath}`;
        const target = `${host}${cleanPath}/512/${encodeURIComponent(z)}/${encodeURIComponent(x)}/${encodeURIComponent(y)}/2/1_1.png`;
        const tileRes = await fetch(target, {
          signal: AbortSignal.timeout(10_000),
        });
        if (tileRes.ok) {
          const buf = Buffer.from(await tileRes.arrayBuffer());
          res.status(200);
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=300');
          res.setHeader('X-Weather-Source', 'rainviewer-tile-proxy');
          return res.send(buf);
        }
      }
      return res.status(204).end();
    } catch {
      return res.status(204).end();
    }
  }

  // Dedicated European live Doppler radar endpoint (cached 2 min)
  if (subPath.startsWith('radar')) {
    try {
      const radarResponse = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
        headers: { Accept: 'application/json' },
      });
      if (!radarResponse.ok) {
        throw new Error(`RainViewer HTTP ${radarResponse.status}`);
      }
      const radarJson = await radarResponse.json();
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      res.setHeader('X-Weather-Source', 'radar-nowcast');
      return res.json(radarJson);
    } catch (radarErr) {
      const msg = radarErr instanceof Error ? radarErr.message : String(radarErr);
      return res.status(502).json({ error: 'Radar service unavailable', detail: msg });
    }
  }

  const upstreamBase = (process.env.WEATHER_UPSTREAM ?? DEFAULT_VPS_UPSTREAM).replace(/\/+$/, '');
  if (!upstreamBase) {
    return res.status(503).json({ error: 'WEATHER_UPSTREAM environment variable is not configured' });
  }
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
    // SÉCURISÉ : Confinement strict du fallback local dans dist_weather (Anti-Path-Traversal)
    const rawTargetName = subPath.split('?')[0].replace(/\0/g, '').trim();
    const fallbackDir = path.resolve(process.cwd(), 'dist_weather');

    // Rejeter immédiatement toute tentative de traversée ou chemin absolu
    const isSuspicious = !rawTargetName ||
      rawTargetName.includes('..') ||
      path.isAbsolute(rawTargetName) ||
      rawTargetName.startsWith('/') ||
      rawTargetName.startsWith('\\');

    if (!isSuspicious) {
      const localFallbackFile = path.resolve(fallbackDir, rawTargetName);
      const isContained = localFallbackFile.startsWith(fallbackDir + path.sep);

      if (isContained && fs.existsSync(localFallbackFile)) {
        try {
          const stat = fs.statSync(localFallbackFile);
          if (stat.isFile()) {
            const content = fs.readFileSync(localFallbackFile);
            const contentType =
              rawTargetName.endsWith('.webp') ? 'image/webp' :
              rawTargetName.endsWith('.png') ? 'image/png' :
              'application/json; charset=utf-8';

            res.status(200);
            res.setHeader('Content-Type', contentType);
            res.setHeader('X-Weather-Source', 'local-fallback');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=60');
            return res.send(content);
          }
        } catch {
          // Ignorer silencieusement si lecture impossible
        }
      }
    }

    console.warn(`[weather-proxy] upstream fetch failed:`, err instanceof Error ? err.message : err);
    return res.status(502).json({
      error: 'Weather service temporarily unavailable',
    });
  }
}
