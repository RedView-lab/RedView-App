/**
 * Proxy → BRouter autonome (VPS, port 17777 derrière le nginx de l'hôte).
 *
 * Deux points d'accès multiplexés sur un seul gestionnaire :
 *
 *   GET  /api/brouter?lonlats=...&profile=trekking[&profile:xxx=...]
 *        → transmet la requête de routage BRouter standard.
 *
 *   POST /api/brouter?upload=1
 *        corps = texte complet du profil BRF (UTF-8, ≤ 100 000 caractères)
 *        → envoie un profil personnalisé, renvoie { profileid: "custom_<hash>" }.
 *        L'id est dérivé côté serveur du contenu du profil (sha256,
 *        16 caractères hexadécimaux) ; tout `?id=` fourni par le client est
 *        ignoré. Utiliser l'id renvoyé dans les GET suivants comme
 *        `profile=custom_<hash>`.
 *
 * Pourquoi un proxy ?
 *   - BRouter répond en HTTP simple et seulement aux clients locaux (sinon le
 *     nginx du VPS renvoie 403) : le navigateur reste en même origine
 *     (`/api/brouter`), sans contenu mixte ni CORS.
 *   - Les paramètres de requête sont en liste blanche (pas de beeline), le
 *     coefficient A* est borné côté serveur et les routes sont mises en cache
 *     compressées.
 *
 * Variable d'environnement serveur (voir .env.example) :
 *   BROUTER_UPSTREAM=http://<VPS_IP>          (nginx de l'hôte : /brouter → 127.0.0.1:17777)
 *   # ou
 *   BROUTER_UPSTREAM=http://<VPS_IP>:17777    (BRouter en direct)
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { createByteLru } from '../server/lib/byte-lru.mjs';
import { resolvePass1Coefficient } from './_lib/brouter-search.js';
import type { ApiRequest, ApiResponse } from './_lib/types.js';
import { createUpstreamGate, UpstreamBusyError, type UpstreamSlot } from './_lib/upstreamGate.js';

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

// Attente dans la file comprise : sous le proxy_read_timeout de 60 s du nginx de l'hôte.
const ROUTE_TIMEOUT_MS = 55_000;
/** Temps de calcul laissé au minimum à une requête sortie tard de la file. */
const ROUTE_MIN_COMPUTE_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 15_000;

/**
 * Calculs envoyés en même temps à BRouter : ses `maxthreads` (4 en
 * production, server/vps/brouter.service). Au-delà, BRouter tue son calcul
 * le plus ancien ; ici la requête attend son tour (_lib/upstreamGate.ts).
 * Les réponses du cache ne passent jamais par la file.
 */
const BROUTER_SLOTS = Math.max(1, Number(process.env.BROUTER_MAX_CONCURRENCY) || 4);
/** Attente au-delà de laquelle on répond 503 + Retry-After (ROUTE_TIMEOUT_MS − ROUTE_MIN_COMPUTE_MS). */
const QUEUE_MAX_WAIT_MS = 35_000;
const brouterGate = createUpstreamGate({ slots: BROUTER_SLOTS, maxQueue: 64, maxWaitMs: QUEUE_MAX_WAIT_MS });

/**
 * Place dans la file de BRouter, ou null quand la réponse est déjà partie
 * (client parti pendant l'attente : rien n'est envoyé ; file saturée : 503).
 */
async function acquireBrouterSlot(res: ApiResponse, signal: AbortSignal, clientGone: () => boolean): Promise<UpstreamSlot | null> {
  try {
    const slot = await brouterGate.acquire(signal);
    // Temps passé dans la file (diagnostic, bancs de charge).
    res.setHeader('X-Upstream-Wait-Ms', String(Math.round(slot.waitedMs)));
    return slot;
  } catch (error) {
    if (clientGone()) return null;
    if (error instanceof UpstreamBusyError) {
      res.setHeader('Retry-After', '5');
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: 'BRouter busy, retry shortly' });
      return null;
    }
    throw error;
  }
}
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
/* GET → requête de routage /brouter                                   */
/* ------------------------------------------------------------------ */

interface CachedRoute {
  /** GeoJSON compressé en brotli : servi tel quel à un navigateur. */
  brotli: Buffer;
  contentType: string;
  status: number;
}
/**
 * Borné en octets (et non en nombre d'entrées) : un tracé multi-jours pèse
 * plusieurs Mo. Garder la version brotli (~8× plus petite) tient d'autant plus
 * de tracés et évite de recompresser à chaque HIT.
 */
const ROUTE_CACHE = createByteLru<CachedRoute>({
  maxBytes: 48 * 1024 * 1024,
  sizeOf: (entry) => entry.brotli.length,
  ttlMs: 60 * 60 * 1000, // 1 hour
});

/*
 * Compression du GeoJSON vers le navigateur : server.mjs ne compresse que les
 * fichiers statiques, et un tracé de 1 000 km pèse ~5 Mo (≈ 0,6 Mo en brotli).
 */
const brotliAsync = promisify(zlib.brotliCompress);
const brotliDecompressAsync = promisify(zlib.brotliDecompress);
const gzipAsync = promisify(zlib.gzip);
const COMPRESS_MIN_CHARS = 4_096;

function compressRoute(raw: Buffer): Promise<Buffer> {
  return brotliAsync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

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

/** `brotli` : version déjà compressée du même corps (mise en cache), réutilisée si le client accepte br. */
async function sendRouteBody(req: ApiRequest, res: ApiResponse, status: number, body: string, brotli: Buffer | null) {
  res.setHeader('Vary', 'Accept-Encoding');
  const encoding = body.length >= COMPRESS_MIN_CHARS ? negotiateEncoding(req) : null;
  if (!encoding) return res.status(status).send(body);
  const raw = Buffer.from(body, 'utf8');
  const packed = encoding === 'br'
    ? brotli ?? await compressRoute(raw)
    : await gzipAsync(raw, { level: 6 });
  res.setHeader('Content-Encoding', encoding);
  return res.status(status).send(packed);
}

/** Tracé du cache : brotli tel quel, sinon décompressé pour un client sans br (rare). */
async function sendCachedRoute(req: ApiRequest, res: ApiResponse, entry: CachedRoute) {
  if (negotiateEncoding(req) === 'br') {
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Encoding', 'br');
    return res.status(entry.status).send(entry.brotli);
  }
  const body = (await brotliDecompressAsync(entry.brotli)).toString('utf8');
  return sendRouteBody(req, res, entry.status, body, null);
}

async function handleRouteQuery(
  req: ApiRequest,
  res: ApiResponse,
  base: string,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    // Accepte les clés en liste blanche + chaque surcharge `profile:xxx`
    // (syntaxe BRouter pour ajuster une à une les valeurs `assign` déclarées
    // dans le profil de base).
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
  if (cached) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=7200');
    res.setHeader('X-Route-Cache', 'HIT');
    return sendCachedRoute(req, res, cached);
  }

  const url = `${base}/brouter?${params.toString()}`;

  const controller = new AbortController();
  // Client parti (nouvelle édition côté app, onglet fermé) : on libère BRouter
  // au lieu de laisser tourner un calcul de jusqu'à 55 s pour personne — et
  // une requête encore dans la file n'y part jamais.
  let clientGone = false;
  const onClientClose = () => {
    if (res.writableFinished) return;
    clientGone = true;
    controller.abort();
  };
  res.once('close', onClientClose);

  const slot = await acquireBrouterSlot(res, controller.signal, () => clientGone);
  if (!slot) {
    res.off('close', onClientClose);
    return;
  }
  const computeBudgetMs = Math.max(ROUTE_MIN_COMPUTE_MS, ROUTE_TIMEOUT_MS - slot.waitedMs);
  const timer = setTimeout(() => controller.abort(), computeBudgetMs);
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
    slot.release();
    res.off('close', onClientClose);
    if (clientGone) return;
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    if (!isAbort) console.error('[brouter] upstream unreachable:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort
        ? `BRouter upstream timeout after ${computeBudgetMs}ms`
        : 'BRouter upstream unreachable',
    });
  }
  clearTimeout(timer);
  slot.release();
  res.off('close', onClientClose);

  const contentType =
    upstreamRes.headers.get('content-type') ?? 'application/json';

  // BRouter renvoie du texte brut « error: ... » avec un HTTP 200 sur les
  // échecs de routage. On les remonte en 422 pour que le client puisse réagir.
  const looksLikeError =
    !contentType.includes('json') ||
    body.trimStart().toLowerCase().startsWith('error');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  if (looksLikeError) {
    // Remonte aussi le texte d'erreur amont dans un en-tête dédié, au cas où le
    // corps serait consommé / filtré sur le chemin du retour vers le
    // navigateur (certains CDN retirent les corps 422 en texte brut). Tronqué
    // pour garder des en-têtes petits.
    res.setHeader('x-brouter-upstream-error', sanitizeHeaderValue(body));
    return res.status(422).send(body);
  }

  let brotli: Buffer | null = null;
  if (upstreamRes.status === 200) {
    brotli = await compressRoute(Buffer.from(body, 'utf8'));
    ROUTE_CACHE.set(cacheKey, { brotli, contentType, status: upstreamRes.status });
  }
  return sendRouteBody(req, res, upstreamRes.status, body, brotli);
}

/* ------------------------------------------------------------------ */
/* POST → /brouter/profile (envoi d'un BRF personnalisé)               */
/* ------------------------------------------------------------------ */

async function handleProfileUpload(
  req: ApiRequest,
  res: ApiResponse,
  base: string,
) {
  // Accepte un corps text/plain brut OU du JSON { profile: "<brf>" } OU un Buffer.
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
  let clientGone = false;
  const onClientClose = () => {
    if (res.writableFinished) return;
    clientGone = true;
    controller.abort();
  };
  res.once('close', onClientClose);
  // La compilation d'un profil occupe aussi un fil de BRouter.
  const slot = await acquireBrouterSlot(res, controller.signal, () => clientGone);
  res.off('close', onClientClose);
  if (!slot) return;
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let upstreamRes: Response;
  let text: string;
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
    text = await upstreamRes.text();
  } catch (err) {
    clearTimeout(timer);
    slot.release();
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    if (!isAbort) console.error('[brouter] profile upload upstream unreachable:', err);
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort
        ? `BRouter profile upload timeout after ${UPLOAD_TIMEOUT_MS}ms`
        : 'BRouter upstream unreachable',
    });
  }
  clearTimeout(timer);
  slot.release();

  // Jamais de cache pour les envois de profil.
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
