/**
 * Proxy météo de RedView (server.mjs en prod et plugin Vite en dev).
 * Relaie les tuiles et métadonnées météo vers le VPS Oracle auto-hébergé.
 *
 * Points d'accès :
 *   GET /api/weather/meta.json
 *   GET /api/weather/tiles/:variable/:hour.(webp|png)
 *   GET /api/weather/point?lat=...&lon=...
 *   GET /api/weather/radar.json (images radar RainViewer, relayées et mises en cache)
 *
 * Variable d'environnement amont (obligatoire pour le relais VPS ; si absente,
 * seul le repli local `dist_weather/` est servi, sinon 503) :
 *   WEATHER_UPSTREAM=http://<vps-ip>/weather
 */
import type { ApiRequest, ApiResponse } from './_lib/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { createByteLru } from '../server/lib/byte-lru.mjs';

const TIMEOUT_MS = 15_000;

/** Liste des images radar RainViewer : une nouvelle image toutes les 10 min, gardée 1 min pour tous les clients. */
const RADAR_MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const RADAR_MAPS_CACHE_KEY = 'radar-maps';
const RADAR_MAPS_TTL_MS = 60_000;

interface CacheEntry {
  body: Buffer;
  contentType: string;
  status: number;
  expiresAt: number;
}

// Borné en octets (tuiles de quelques centaines de Ko) ; durée de vie par
// entrée (tuile 1 h, méta 1 min).
const memoryCache = createByteLru<CacheEntry>({
  maxBytes: 32 * 1024 * 1024,
  sizeOf: (entry) => entry.body.length,
});

function getCached(key: string): CacheEntry | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry;
}

function setCached(key: string, entry: CacheEntry) {
  memoryCache.set(key, entry);
}

/**
 * SÉCURISÉ : Confinement strict du fallback local dans dist_weather
 * (Anti-Path-Traversal). Retourne true si une réponse a été envoyée.
 */
function serveLocalFallback(subPath: string, res: ApiResponse): boolean {
  const rawTargetName = subPath.split('?')[0].replace(/\0/g, '').trim();
  const fallbackDir = path.resolve(process.cwd(), 'dist_weather');

  // Rejeter immédiatement toute tentative de traversée ou chemin absolu
  const isSuspicious = !rawTargetName ||
    rawTargetName.includes('..') ||
    path.isAbsolute(rawTargetName) ||
    rawTargetName.startsWith('/') ||
    rawTargetName.startsWith('\\');
  if (isSuspicious) return false;

  const localFallbackFile = path.resolve(fallbackDir, rawTargetName);
  const isContained = localFallbackFile.startsWith(fallbackDir + path.sep);
  if (!isContained || !fs.existsSync(localFallbackFile)) return false;

  try {
    const stat = fs.statSync(localFallbackFile);
    if (!stat.isFile()) return false;
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
    res.send(content);
    return true;
  } catch {
    // Ignorer silencieusement si lecture impossible
    return false;
  }
}

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
  if (rawUrl.includes('..') || rawUrl.includes('%2e') || rawUrl.includes('%2E')) {
    return res.status(400).json({ error: 'Invalid path parameter' });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, 'http://localhost');
  } catch {
    parsedUrl = new URL('/api/weather', 'http://localhost');
  }
  const rawSubPath = parsedUrl.pathname.replace(/^\/api\/weather\/?/, '') || 'meta.json';
  let subPath: string;
  try {
    subPath = decodeURIComponent(rawSubPath);
  } catch {
    subPath = rawSubPath;
  }
  subPath = subPath.replace(/^\/+/, '');

  if (!/^[a-zA-Z0-9_\-.:/]+$/.test(subPath) || subPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path parameter' });
  }

  // Liste des images radar RainViewer (`/api/weather/radar.json`). Les tuiles
  // radar passent par `/radar-tiles/*` (Service Worker, sinon server.mjs).
  if (subPath.startsWith('radar')) {
    const sendRadarMaps = (body: Buffer) => {
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      res.setHeader('X-Weather-Source', 'radar-nowcast');
      return res.send(body);
    };
    const cachedMaps = getCached(RADAR_MAPS_CACHE_KEY);
    if (cachedMaps) return sendRadarMaps(cachedMaps.body);
    try {
      const { response, body } = await fetchUpstream(RADAR_MAPS_URL);
      if (!response.ok) {
        throw new Error(`RainViewer HTTP ${response.status}`);
      }
      setCached(RADAR_MAPS_CACHE_KEY, {
        body,
        contentType: 'application/json; charset=utf-8',
        status: 200,
        expiresAt: Date.now() + RADAR_MAPS_TTL_MS,
      });
      return sendRadarMaps(body);
    } catch (radarErr) {
      console.warn('[weather-proxy] radar fetch failed:', radarErr);
      return res.status(502).json({ error: 'Radar service unavailable' });
    }
  }

  // 1. Regarde le cache LRU en mémoire (latence < 1 ms)
  const cacheKey = `${subPath}${parsedUrl.search}`;
  const cached = getCached(cacheKey);
  if (cached) {
    res.status(cached.status);
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('X-Weather-Source', 'memory-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (subPath.includes('tiles/')) {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    }
    return res.send(cached.body);
  }

  // Plus de fallback codé en dur vers une IP : sans WEATHER_UPSTREAM on ne
  // contacte aucun amont, on sert le fallback local s'il existe, sinon 503.
  const upstreamBase = (process.env.WEATHER_UPSTREAM ?? '').trim().replace(/\/+$/, '');
  if (!upstreamBase) {
    if (serveLocalFallback(subPath, res)) return;
    console.warn('[weather-proxy] WEATHER_UPSTREAM is not configured');
    return res.status(503).json({ error: 'Weather service temporarily unavailable' });
  }
  const targetUrl = `${upstreamBase}/${subPath}${parsedUrl.search}`;

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

    // Remplit le cache mémoire : 60 s pour les métadonnées, 1 h pour les tuiles raster immuables
    const ttlMs = subPath.includes('tiles/') ? 3_600_000 : 60_000;
    setCached(cacheKey, {
      body,
      contentType,
      status: response.status,
      expiresAt: Date.now() + ttlMs,
    });

    res.status(response.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Weather-Source', 'oracle-vps');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (subPath.includes('tiles/')) {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    }

    return res.send(body);
  } catch (err) {
    if (serveLocalFallback(subPath, res)) return;

    console.warn(`[weather-proxy] upstream fetch failed:`, err instanceof Error ? err.message : err);
    return res.status(502).json({
      error: 'Weather service temporarily unavailable',
    });
  }
}
