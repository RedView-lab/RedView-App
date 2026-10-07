import type { ApiRequest, ApiResponse } from './_lib/types.js';
import { createByteLru } from '../server/lib/byte-lru.mjs';

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 12_000;
const USER_AGENT = 'RedViewPRODUCTION/1.0 (iconic geocoder proxy)';
const MAX_QUERY_LENGTH = 200;

/**
 * Politique d'usage de nominatim.openstreetmap.org : une requête par seconde
 * au plus pour toute l'application, sinon l'IP du serveur est bloquée. Les
 * appels amont sont donc espacés d'une seconde, toutes requêtes confondues ;
 * une requête qui devrait attendre plus de `MAX_QUEUE_WAIT_MS` répond 503 (le
 * client se passe alors des lieux emblématiques, comme sur un échec amont).
 */
const UPSTREAM_INTERVAL_MS = 1_000;
const MAX_QUEUE_WAIT_MS = 2_000;
let nextUpstreamSlotAt = 0;

/** Réponses gardées une journée : les mêmes saisies reviennent d'un utilisateur à l'autre. */
const responseCache = createByteLru<Buffer>({
  maxBytes: 4 * 1024 * 1024,
  sizeOf: (body) => body.length,
  ttlMs: 24 * 60 * 60_000,
});

function readQueryParam(req: ApiRequest, key: string): string {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function clampLimit(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(parsed, 6));
}

function sanitizeCountryCodes(raw: string): string | null {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^[a-z]{2}$/.test(part));
  return parts.length > 0 ? parts.join(',') : null;
}

/** Code de langue (`fr`, `en`, `pt-BR`…) ; `fr` pour toute autre valeur. */
function sanitizeLanguage(raw: string): string {
  const language = raw.trim();
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(language) ? language : 'fr';
}

function previewText(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

/** Réserve le prochain créneau amont : attente en ms, ou `null` si elle dépasserait `MAX_QUEUE_WAIT_MS`. */
function reserveUpstreamSlot(now: number): number | null {
  const slotAt = Math.max(now, nextUpstreamSlotAt);
  const waitMs = slotAt - now;
  if (waitMs > MAX_QUEUE_WAIT_MS) return null;
  nextUpstreamSlotAt = slotAt + UPSTREAM_INTERVAL_MS;
  return waitMs;
}

async function fetchWithTimeout(target: string): Promise<Response> {
  return fetch(target, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
}

function sendResults(res: ApiResponse, body: Buffer, cache: 'hit' | 'miss') {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
  res.setHeader('X-Geocoder-Source', 'nominatim');
  res.setHeader('X-Geocoder-Cache', cache);
  return res.send(body);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = readQueryParam(req, 'q').trim();
  if (query.length < 2 || query.length > MAX_QUERY_LENGTH) {
    return res.status(400).json({ error: 'Missing or invalid query' });
  }

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    extratags: '1',
    limit: String(clampLimit(readQueryParam(req, 'limit'))),
  });
  // Le client envoie `accept-language` (nom du paramètre Nominatim).
  params.set('accept-language', sanitizeLanguage(readQueryParam(req, 'accept-language') || readQueryParam(req, 'language')));

  const countryCodes = sanitizeCountryCodes(readQueryParam(req, 'countrycodes'));
  if (countryCodes) params.set('countrycodes', countryCodes);

  const cacheKey = params.toString();
  const cached = responseCache.get(cacheKey);
  if (cached) return sendResults(res, cached, 'hit');

  const waitMs = reserveUpstreamSlot(Date.now());
  if (waitMs === null) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'Iconic geocoder busy' });
  }
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  // Saisie remplacée pendant l'attente : le client a fermé la requête.
  if (req.socket?.destroyed) return;

  try {
    const upstream = await fetchWithTimeout(`${NOMINATIM_ENDPOINT}?${cacheKey}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) {
      // Détail amont uniquement dans les logs serveur.
      console.warn(
        `[geocode-iconic] upstream HTTP ${upstream.status}:`,
        previewText(body.toString('utf-8')),
      );
      return res.status(502).json({ error: 'Iconic geocoder upstream failed' });
    }

    responseCache.set(cacheKey, body);
    return sendResults(res, body, 'miss');
  } catch (error) {
    console.error('[geocode-iconic] request failed:', error);
    return res.status(502).json({ error: 'Iconic geocoder request failed' });
  }
}
