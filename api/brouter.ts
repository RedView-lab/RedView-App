/**
 * Vercel serverless proxy → BRouter standalone (DigitalOcean droplet).
 *
 * Two endpoints muxed on a single function:
 *
 *   GET  /api/brouter?lonlats=...&profile=trekking[&profile:xxx=...]
 *        → forwards the standard BRouter routing query.
 *
 *   POST /api/brouter?upload=1
 *        body = full BRF profile text (UTF-8, ≤ 100 000 chars)
 *        → uploads a custom profile, returns { profileid: "custom_<hash>" }.
 *        The id is derived server-side from the profile content
 *        (sha256, 16 hex chars); any client-supplied `?id=` is ignored.
 *        Use the returned id in subsequent GETs as `profile=custom_<hash>`.
 *
 * Why a proxy?
 *   - Vercel apps run over HTTPS. Calling `http://<vps-ip>` from the
 *     browser triggers a mixed-content block, and we'd also need CORS
 *     headers on every BRouter response.
 *   - With this proxy:
 *       • the browser stays same-origin (`/api/brouter`),
 *       • the VPS IP is hidden in `BROUTER_UPSTREAM` (server-only env var),
 *       • CORS is simply not an issue.
 *
 * Required env var on Vercel:
 *   BROUTER_UPSTREAM=http://<DROPLET_IP>          (nginx on port 80)
 *   # or
 *   BROUTER_UPSTREAM=http://<DROPLET_IP>:17777    (BRouter direct)
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { resolvePass1Coefficient } from './_lib/brouter-search.js';
import type { ApiRequest, ApiResponse } from './_lib/types.js';

// Jamais de segment en ligne droite (« beeline ») dans un tracé : ni `straight`
// (via reliés à vol d'oiseau), ni `add_beeline` (départ / arrivée loin du
// réseau rejoint en ligne droite), même demandés par un client.
const ALLOWED_PARAMS = new Set([
  'lonlats',
  'nogos',
  'polylines',
  'polygons',
  'profile',
  'alternativeidx',
  'format',
  'timode',
  'heading',
  'exportWaypoints',
  'exportCorrectedWaypoints',
  'trackname',
]);

const BEELINE_OVERRIDE = 'profile:add_beeline';

const ROUTE_TIMEOUT_MS = 55_000; // Vercel hobby cap is 60 s.
const UPLOAD_TIMEOUT_MS = 15_000;
const MAX_PROFILE_BYTES = 100_000;
const MAX_ERROR_HEADER_CHARS = 200;

/** Valeur d'en-tête sûre : ASCII imprimable uniquement, tronquée. */
function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, MAX_ERROR_HEADER_CHARS);
}

export default async function handler(
  req: ApiRequest,
  res: ApiResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  const upstream = (process.env.BROUTER_UPSTREAM ?? '').trim() || 'http://localhost:17777';
  const base = upstream.replace(/\/+$/, '').replace(/\/brouter$/, '');

  if (req.method === 'POST') {
    return handleProfileUpload(req, res, base);
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return handleRouteQuery(req, res, base);
}

/* ------------------------------------------------------------------ */
/* GET → /brouter routing query                                        */
/* ------------------------------------------------------------------ */

interface CachedRoute {
  body: string;
  contentType: string;
  status: number;
  timestamp: number;
}
const ROUTE_CACHE = new Map<string, CachedRoute>();
/**
 * Borne en octets (et non en nombre d'entrées) : un tracé multi-jours pèse
 * plusieurs Mo, 512 entrées pouvaient atteindre des Go en mémoire.
 */
const MAX_ROUTE_CACHE_BYTES = 64 * 1024 * 1024;
let routeCacheBytes = 0;

function cachedRouteBytes(key: string, entry: CachedRoute): number {
  return (key.length + entry.body.length) * 2;
}

function deleteCachedRoute(key: string) {
  const entry = ROUTE_CACHE.get(key);
  if (!entry) return;
  routeCacheBytes -= cachedRouteBytes(key, entry);
  ROUTE_CACHE.delete(key);
}

function rememberRoute(key: string, entry: CachedRoute) {
  const bytes = cachedRouteBytes(key, entry);
  if (bytes > MAX_ROUTE_CACHE_BYTES / 4) return;
  deleteCachedRoute(key);
  while (routeCacheBytes + bytes > MAX_ROUTE_CACHE_BYTES && ROUTE_CACHE.size > 0) {
    const oldestKey = ROUTE_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    deleteCachedRoute(oldestKey);
  }
  ROUTE_CACHE.set(key, entry);
  routeCacheBytes += bytes;
}
const ROUTE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/*
 * Compression du GeoJSON vers le navigateur : server.mjs ne compresse que les
 * fichiers statiques, et un tracé de 1 000 km pèse ~5 Mo (≈ 0,6 Mo en brotli).
 */
const brotliAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);
const COMPRESS_MIN_CHARS = 4_096;

function negotiateEncoding(req: ApiRequest): 'br' | 'gzip' | null {
  const accepted = new Map<string, number>();
  for (const part of String(req.headers?.['accept-encoding'] ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((token) => token.trim());
    if (!name) continue;
    const q = params.find((param) => param.startsWith('q='));
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  if ((accepted.get('br') ?? 0) > 0) return 'br';
  if ((accepted.get('gzip') ?? 0) > 0) return 'gzip';
  return null;
}

async function sendRouteBody(req: ApiRequest, res: ApiResponse, status: number, body: string) {
  res.setHeader('Vary', 'Accept-Encoding');
  const encoding = body.length >= COMPRESS_MIN_CHARS ? negotiateEncoding(req) : null;
  if (!encoding) return res.status(status).send(body);
  const raw = Buffer.from(body, 'utf8');
  const packed = encoding === 'br'
    ? await brotliAsync(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      })
    : await gzipAsync(raw, { level: 6 });
  res.setHeader('Content-Encoding', encoding);
  return res.status(status).send(packed);
}

async function handleRouteQuery(
  req: ApiRequest,
  res: ApiResponse,
  base: string,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    // Allow whitelisted keys + every `profile:xxx` override (BRouter syntax
    // for tweaking individual `assign` values declared in the base profile).
    const allowed = ALLOWED_PARAMS.has(key) || (key.startsWith('profile:') && key !== BEELINE_OVERRIDE);
    if (!allowed) continue;
    if (Array.isArray(value)) params.set(key, value[0] ?? '');
    else if (typeof value === 'string') params.set(key, value);
  }

  if (!params.has('lonlats')) {
    return res.status(400).json({ error: 'Missing "lonlats" parameter' });
  }
  if (!params.has('format')) params.set('format', 'geojson');
  if (!params.has('profile')) params.set('profile', 'trekking');

  // Passe unique imposée (la passe exacte est quadratique sur les longs tracés) ;
  // coefficient A* du client borné selon la distance (calculé s'il manque).
  params.set('profile:pass2coefficient', '-1');
  params.set(
    'profile:pass1coefficient',
    String(resolvePass1Coefficient(params.get('lonlats') ?? '', params.get('profile:pass1coefficient'))),
  );

  const cacheKey = params.toString();
  const cached = ROUTE_CACHE.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < ROUTE_CACHE_TTL_MS) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=7200');
    res.setHeader('X-Route-Cache', 'HIT');
    return sendRouteBody(req, res, cached.status, cached.body);
  }

  const url = `${base}/brouter?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  // Client parti (nouvelle édition côté app, onglet fermé) : on libère BRouter
  // au lieu de laisser tourner un calcul de jusqu'à 55 s pour personne.
  let clientGone = false;
  const onClientClose = () => {
    if (res.writableFinished) return;
    clientGone = true;
    controller.abort();
  };
  res.once('close', onClientClose);

  let upstreamRes: Response;
  let body: string;
  try {
    upstreamRes = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json,application/geo+json,text/plain' },
    });
    body = await upstreamRes.text();
  } catch (err) {
    clearTimeout(timer);
    res.off('close', onClientClose);
    if (clientGone) return;
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    if (!isAbort) console.error('[brouter] upstream unreachable:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort
        ? `BRouter upstream timeout after ${ROUTE_TIMEOUT_MS}ms`
        : 'BRouter upstream unreachable',
    });
  }
  clearTimeout(timer);
  res.off('close', onClientClose);

  const contentType =
    upstreamRes.headers.get('content-type') ?? 'application/json';

  // BRouter returns plain-text "error: ..." with HTTP 200 on routing
  // failures. Surface them as 422 so the client can react.
  const looksLikeError =
    !contentType.includes('json') ||
    body.trimStart().toLowerCase().startsWith('error');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  if (looksLikeError) {
    // Surface upstream error text in a custom header too, in case the
    // body is consumed/filtered on the way back to the browser (some
    // CDNs strip plain-text 422 bodies). Truncate to keep headers small.
    res.setHeader('x-brouter-upstream-error', sanitizeHeaderValue(body));
  } else if (upstreamRes.status === 200) {
    rememberRoute(cacheKey, {
      body,
      contentType,
      status: upstreamRes.status,
      timestamp: now,
    });
  }

  if (looksLikeError) return res.status(422).send(body);
  return sendRouteBody(req, res, upstreamRes.status, body);
}

/* ------------------------------------------------------------------ */
/* POST → /brouter/profile (custom BRF upload)                         */
/* ------------------------------------------------------------------ */

async function handleProfileUpload(
  req: ApiRequest,
  res: ApiResponse,
  base: string,
) {
  // Accept either raw text/plain body OR JSON { profile: "<brf>" } OR Buffer.
  let profileText: string | null = null;
  if (typeof req.body === 'string') {
    profileText = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    profileText = req.body.toString('utf-8');
  } else if (req.body && typeof req.body === 'object') {
    const maybe = (req.body as { profile?: unknown }).profile;
    if (typeof maybe === 'string') profileText = maybe;
  }

  if (!profileText || profileText.trim().length === 0) {
    return res.status(400).json({
      error:
        'POST body must contain BRF profile text (text/plain or { profile })',
    });
  }
  if (profileText.length > MAX_PROFILE_BYTES) {
    return res.status(413).json({
      error: `Profile exceeds ${MAX_PROFILE_BYTES} chars`,
    });
  }

  // Passe unique imposée dans les profils téléversés. Le coefficient A* réel
  // est fixé à chaque requête (GET) ; 3.5 n'est qu'une valeur par défaut sûre.
  if (/assign\s+pass2coefficient\s*=/i.test(profileText)) {
    profileText = profileText.replace(/assign\s+pass2coefficient\s*=\s*[\d.-]+/gi, 'assign pass2coefficient = -1');
  } else {
    profileText = `${profileText}\nassign pass2coefficient = -1\n`;
  }
  // Jamais de départ / d'arrivée rejoint en ligne droite (cf. ALLOWED_PARAMS).
  if (/assign\s+add_beeline\s*=/i.test(profileText)) {
    profileText = profileText.replace(/assign\s+add_beeline\s*=\s*[^\s#]+/gi, 'assign add_beeline = false');
  } else {
    profileText = `${profileText}\nassign add_beeline = false\n`;
  }
  if (/assign\s+pass1coefficient\s*=/i.test(profileText)) {
    profileText = profileText.replace(/assign\s+pass1coefficient\s*=\s*[\d.-]+/gi, 'assign pass1coefficient = 3.5');
  } else {
    profileText = `${profileText}\nassign pass1coefficient = 3.5\n`;
  }

  // Id dérivé du contenu (et non plus fourni par le client) : un client ne
  // peut plus écraser le profil d'un autre en devinant/réutilisant son id.
  // Même contenu → même id (dédup naturelle côté BRouter). Le `?id=`
  // éventuellement envoyé par le client est ignoré.
  const profileId = `custom_${crypto.createHash('sha256').update(profileText, 'utf8').digest('hex').slice(0, 16)}`;
  const url = `${base}/brouter/profile/${encodeURIComponent(profileId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        Accept: 'application/json,text/plain',
      },
      body: profileText,
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    if (!isAbort) console.error('[brouter] profile upload upstream unreachable:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort
        ? `BRouter profile upload timeout after ${UPLOAD_TIMEOUT_MS}ms`
        : 'BRouter upstream unreachable',
    });
  }
  clearTimeout(timer);

  const text = await upstreamRes.text();
  // Never cache profile uploads.
  res.setHeader('Cache-Control', 'no-store');

  if (!upstreamRes.ok) {
    console.warn(`[brouter] profile upload HTTP ${upstreamRes.status}:`, text.slice(0, 300));
    return res
      .status(upstreamRes.status >= 500 ? 502 : upstreamRes.status)
      .json({ error: 'BRouter profile upload failed' });
  }

  // BRouter répond { profileid, error? } (error = message de compilation BRF,
  // utile au client). On renvoie toujours l'id calculé côté serveur.
  let upstreamJson: { profileid?: unknown; error?: unknown } = {};
  try {
    upstreamJson = JSON.parse(text) as { profileid?: unknown; error?: unknown };
  } catch {
    console.warn('[brouter] profile upload: non-JSON upstream response:', text.slice(0, 300));
    return res.status(502).json({ error: 'BRouter profile upload failed' });
  }
  // BRouter réutilise l'id passé dans le chemin (`custom_<hash>` → <hash>.brf).
  // Si une version amont l'ignorait, l'id qu'elle renvoie est le seul
  // routable : on le relaie (validé) plutôt que de casser le routage.
  let returnedId = profileId;
  if (typeof upstreamJson.profileid === 'string' && upstreamJson.profileid !== profileId) {
    console.warn(
      `[brouter] profile upload: upstream id ${upstreamJson.profileid} differs from ${profileId}`,
    );
    if (/^custom_[A-Za-z0-9_-]{1,64}$/.test(upstreamJson.profileid)) {
      returnedId = upstreamJson.profileid;
    }
  }

  const payload: { profileid: string; error?: string } = { profileid: returnedId };
  if (typeof upstreamJson.error === 'string' && upstreamJson.error) {
    payload.error = upstreamJson.error;
  }
  return res.status(200).json(payload);
}
