/**
 * Proxy de nuages de points LiDAR pour les sources publiques sans CORS.
 *
 *   GET|HEAD /api/pointcloud?url=<URL amont encodée>
 *
 * Seules les URL de `resolvePointcloudUpstream` (server/http-security.mjs)
 * passent : sous-dalles AHN de GeoTiles (Pays-Bas) et morceaux de bandes DHMV
 * II d'EODaS OpenLidar (Flandre). Le corps est relayé en flux (jamais
 * bufferisé : une sous-dalle AHN pèse 50 Mio à 1 Gio) et l'en-tête `Range`
 * est transmis, ce qui permet au client de reprendre un téléchargement
 * interrompu. Les redirections amont sont refusées (pas de rebond SSRF).
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { getClientIp, rateLimitKeyForIp, resolvePointcloudUpstream, sanitizeRangeHeader } from '../server/http-security.mjs';
import { sendMethodNotAllowed } from './_lib/http.js';
import type { ApiRequest, ApiResponse } from './_lib/types.js';

/** Flux simultanés : le client télécharge un fichier à la fois, quelques onglets au plus. */
const MAX_STREAMS_PER_CLIENT = 4;
const MAX_STREAMS = 32;
/** Attente des en-têtes amont ; le corps, lui, n'a pas de limite de durée. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000;
const RELAYED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'] as const;

interface ProxyState {
  active: number;
  perClient: Map<string, number>;
}

// Sur globalThis : le serveur de dev recharge le module à chaque requête.
const state: ProxyState = ((globalThis as { __rvPointcloudProxy?: ProxyState }).__rvPointcloudProxy ??= {
  active: 0,
  perClient: new Map(),
});

function release(client: string): void {
  state.active = Math.max(0, state.active - 1);
  const count = (state.perClient.get(client) ?? 1) - 1;
  if (count > 0) state.perClient.set(client, count);
  else state.perClient.delete(client);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, ['GET', 'HEAD']);

  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  const target = resolvePointcloudUpstream(rawUrl);
  if (!target) return res.status(400).json({ error: 'Source de nuage de points non autorisée' });

  const client = rateLimitKeyForIp(getClientIp(req));
  if (state.active >= MAX_STREAMS || (state.perClient.get(client) ?? 0) >= MAX_STREAMS_PER_CLIENT) {
    res.setHeader('Retry-After', '5');
    return res.status(429).json({ error: 'Trop de téléchargements simultanés' });
  }
  state.active += 1;
  state.perClient.set(client, (state.perClient.get(client) ?? 0) + 1);

  // Le client parti (onglet fermé, annulation), on coupe l'amont.
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on('close', onClose);

  try {
    const headers: Record<string, string> = { 'User-Agent': 'RedView/1.0 (+https://redview.app) LiDAR viewer' };
    const range = sanitizeRangeHeader(req.headers.range);
    if (range) headers.Range = range;

    const headersTimeout = setTimeout(() => controller.abort(), UPSTREAM_HEADERS_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(target, { method: req.method, headers, redirect: 'error', signal: controller.signal });
    } finally {
      clearTimeout(headersTimeout);
    }

    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/octet-stream');
    for (const name of RELAYED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // Fichiers publiés immuables : cache navigateur, jamais les erreurs.
    res.setHeader('Cache-Control', upstream.ok ? 'public, max-age=604800' : 'no-store');

    if (req.method === 'HEAD' || !upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as unknown as NodeWebReadableStream), res);
  } catch (err) {
    if (controller.signal.aborted && res.destroyed) return;
    console.warn(`[pointcloud] ${target}:`, (err as Error).message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Source de nuage de points injoignable' });
    } else {
      res.destroy();
    }
  } finally {
    res.off('close', onClose);
    release(client);
  }
}
