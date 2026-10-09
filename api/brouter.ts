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
import { markLoadShed } from '../server/lib/request-logging.mjs';
import { effectiveSearchKm, resolvePass1Coefficient } from './_lib/brouter-search.js';
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
/** Plus petit budget de calcul (`budgetMs`) accepté d'un client. */
const MIN_BUDGET_MS = 2_000;
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

/**
 * Profils que BRouter a déjà acceptés (compilés sans erreur), par id : texte
 * gardé pour les renvoyer si son fichier venait à manquer. Un envoi coûte
 * ≥ 1 s d'un des 4 fils de BRouter quoi qu'il arrive (ProfileUploadHandler
 * lit le corps jusqu'à `ready() == false`, puis dort 1 000 ms avant de
 * conclure) et compte dans ses `maxthreads` : au-delà, BRouter tue son calcul
 * le plus ancien. Or l'id est l'empreinte du contenu et BRouter ne supprime
 * jamais un profil personnalisé : le renvoyer ne change rien. Banc vps-load du
 * 08/10 : POST /api/brouter = 1 011–1 019 ms à 1 utilisateur, un tiers des
 * requêtes vers BRouter à 100 utilisateurs.
 */
const KNOWN_PROFILES = createByteLru<string>({
  maxBytes: 16 * 1024 * 1024,
  sizeOf: (text) => text.length * 2,
});
const CUSTOM_PROFILE_PREFIX = 'custom_';

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

  // Ce proxy applique `budgetMs` (délai de calcul compté après la file) : le client
  // qui le lit mesure son délai d'escalade sur le calcul seul (customProfileFetch.ts).
  res.setHeader('X-Brouter-Budget', '1');
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
  const hedge = queryValue(req.query.hedge) === '1';
  const budgetMs = parseBudgetMs(queryValue(req.query.budgetMs));
  const effortKm = effectiveSearchKm(params.get('lonlats') ?? '');
  res.setHeader('X-Search-Km', String(Math.round(effortKm)));

  // Client parti (nouvelle édition côté app, onglet fermé) : une requête encore
  // dans la file n'y part jamais, une requête partie est interrompue et sa place
  // rendue. BRouter ne voit pas qu'elle est abandonnée et continue de calculer,
  // mais la requête suivante le lui fait tuer (au-delà de ses fils, il tue son
  // calcul le plus ancien) : garder la place jusqu'à sa réponse coûtait plus
  // cher — tous les calculs abandonnés menés à terme, les vivants en file
  // derrière eux (bench:routing-load du 08/10 : CPU +26 %, geste p50 ×2).
  const controller = new AbortController();
  let clientGone = false;
  const onClientClose = () => {
    if (res.writableFinished) return;
    clientGone = true;
    controller.abort();
  };
  res.once('close', onClientClose);

  const startedAt = Date.now();
  let result!: UpstreamResult;
  for (let attempt = 0; ; attempt += 1) {
    const slot = hedge
      ? takeFreeBrouterSlot(res)
      : await acquireBrouterSlot(res, controller.signal, () => clientGone);
    if (!slot) {
      res.off('close', onClientClose);
      return;
    }
    // Échéance : le budget de calcul du client (compté d'ici, après la file), et
    // toujours sous le délai du proxy (nginx coupe à 60 s).
    const totalBudgetMs = Math.max(ROUTE_MIN_COMPUTE_MS, ROUTE_TIMEOUT_MS - (Date.now() - startedAt));
    const deadlineMs = Math.min(totalBudgetMs, budgetMs ?? Number.POSITIVE_INFINITY);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, deadlineMs);
    try {
      result = await callBrouter(url, controller.signal);
    } finally {
      clearTimeout(timer);
      slot.release();
    }
    if (clientGone) {
      res.off('close', onClientClose);
      return;
    }
    if (expired) {
      res.off('close', onClientClose);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Brouter-Timeout', deadlineMs < totalBudgetMs ? 'compute' : 'total');
      return res.status(504).json({ error: `BRouter upstream timeout after ${deadlineMs}ms` });
    }
    // Un profil accepté plus tôt dont BRouter n'a plus le fichier : renvoyé
    // une fois, puis la même requête rejouée.
    if (result.kind !== 'ok' || attempt > 0 || !(await restoreMissingProfile(base, params.get('profile'), result.body))) break;
  }
  res.off('close', onClientClose);
  if (result.kind !== 'ok') {
    console.error('[brouter] upstream unreachable:', result.error);
    return res.status(502).json({ error: 'BRouter upstream unreachable' });
  }
  res.setHeader('X-Upstream-Compute-Ms', String(result.computeMs));

  const { contentType, body } = result;

  // BRouter renvoie du texte brut « error: ... » avec un HTTP 200 sur les
  // échecs de routage. On les remonte en 422 pour que le client puisse réagir.
  if (isBrouterError(contentType, body)) {
    // Remonte aussi le texte d'erreur amont dans un en-tête dédié, au cas où le
    // corps serait consommé / filtré sur le chemin du retour vers le
    // navigateur (certains CDN retirent les corps 422 en texte brut). Tronqué
    // pour garder des en-têtes petits.
    // Jamais en cache : sous charge, BRouter tue son calcul le plus ancien
    // (« operation killed by thread-priority-watchdog »), et le client réessaie
    // la même URL (client.ts) ; mise en cache par le navigateur, l'erreur lui
    // était resservie à chaque essai sans rien recalculer. Une erreur
    // définitive (aucun tracé) n'est de toute façon pas redemandée telle quelle.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-brouter-upstream-error', sanitizeHeaderValue(body));
    return res.status(422).send(body);
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  let brotli: Buffer | null = null;
  if (result.status === 200) {
    brotli = await compressRoute(Buffer.from(body, 'utf8'));
    ROUTE_CACHE.set(cacheKey, { brotli, contentType, status: result.status });
  }
  return sendRouteBody(req, res, result.status, body, brotli);
}

type UpstreamResult =
  | { kind: 'ok'; status: number; contentType: string; body: string; computeMs: number }
  | { kind: 'unreachable'; error: unknown };

/** Premier paramètre de requête d'un nom (chaîne), ou null. */
function queryValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : null;
}

/** `budgetMs` du client : entier, borné à [MIN_BUDGET_MS, ROUTE_TIMEOUT_MS] ; null s'il manque ou ne se lit pas. */
function parseBudgetMs(value: string | null): number | null {
  if (value == null || !/^\d{1,6}$/.test(value)) return null;
  return Math.min(ROUTE_TIMEOUT_MS, Math.max(MIN_BUDGET_MS, Number(value)));
}

/**
 * Requête de secours (`hedge=1`, customProfileFetch.ts) : une place libre
 * tout de suite, sinon 503 immédiat — un secours en file attendrait derrière
 * les autres et ne ferait qu'ajouter un calcul à un BRouter déjà plein.
 */
function takeFreeBrouterSlot(res: ApiResponse): UpstreamSlot | null {
  const slot = brouterGate.tryAcquire();
  if (slot) {
    res.setHeader('X-Upstream-Wait-Ms', '0');
    return slot;
  }
  // Refus voulu, sans Retry-After (un secours n'est jamais réessayé,
  // customProfileFetch.ts) : journalisé en avertissement, pas en erreur.
  markLoadShed(res);
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({ error: 'BRouter busy, no slot for a backup search' });
  return null;
}

/** Appel à BRouter ; l'annulation (client parti, échéance) lève une AbortError. */
async function callBrouter(url: string, signal: AbortSignal): Promise<UpstreamResult> {
  const dispatchedAt = Date.now();
  try {
    const upstreamRes = await fetch(url, {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json,application/geo+json,text/plain' },
    });
    const body = await upstreamRes.text();
    return {
      kind: 'ok',
      status: upstreamRes.status,
      contentType: upstreamRes.headers.get('content-type') ?? 'application/json',
      body,
      computeMs: Date.now() - dispatchedAt,
    };
  } catch (error) {
    return { kind: 'unreachable', error };
  }
}

/** Texte d'erreur de BRouter (« error: … », HTTP 200 ou non) plutôt qu'un tracé. */
function isBrouterError(contentType: string, body: string): boolean {
  return !contentType.includes('json') || body.trimStart().toLowerCase().startsWith('error');
}


/* ------------------------------------------------------------------ */
/* POST → /brouter/profile (envoi d'un BRF personnalisé)               */
/* ------------------------------------------------------------------ */

type UploadOutcome =
  | { kind: 'ok'; upstreamRes: Response; text: string; waitedMs: number }
  | { kind: 'busy' | 'timeout' | 'unreachable'; waitedMs?: number };

/** Envois en cours, par id de profil (contenu identique). */
const PROFILE_UPLOADS_IN_FLIGHT = new Map<string, Promise<UploadOutcome>>();

/**
 * Un envoi vers BRouter, partagé par toutes les demandes simultanées du même
 * profil. BRouter écrit le profil dans un fichier nommé d'après son id puis
 * le compile : deux envois concurrents du même id réécrivaient ce fichier
 * pendant que l'autre le lisait — profil tronqué, « does not contain
 * expressions for context node », tracé en échec (banc vps-load du 08/10,
 * préréglages courants en rafale). Partager l'envoi supprime la course et la
 * compilation en double. Il passe par la file (_lib/upstreamGate.ts) et va à
 * son terme même si un demandeur part : les autres l'attendent.
 */
async function uploadProfileOnce(base: string, profileId: string, profileText: string): Promise<UploadOutcome> {
  const url = `${base}/brouter/profile/${encodeURIComponent(profileId)}`;
  let slot: UpstreamSlot;
  try {
    slot = await brouterGate.acquire();
  } catch (error) {
    if (error instanceof UpstreamBusyError) return { kind: 'busy' };
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const upstreamRes = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        Accept: 'application/json,text/plain',
      },
      body: profileText,
    });
    const text = await upstreamRes.text();
    if (upstreamRes.ok && compiledCleanly(text, profileId)) KNOWN_PROFILES.set(profileId, profileText);
    return { kind: 'ok', upstreamRes, text, waitedMs: slot.waitedMs };
  } catch (err) {
    const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
    if (!isAbort) console.error('[brouter] profile upload upstream unreachable:', err);
    return { kind: isAbort ? 'timeout' : 'unreachable', waitedMs: slot.waitedMs };
  } finally {
    clearTimeout(timer);
    slot.release();
  }
}

/** Réponse d'envoi de BRouter sans erreur de compilation, sous l'id demandé. */
function compiledCleanly(text: string, profileId: string): boolean {
  try {
    const json = JSON.parse(text) as { profileid?: unknown; error?: unknown };
    return !json.error && (json.profileid === undefined || json.profileid === profileId);
  } catch {
    return false;
  }
}

/** Mêmes réglages = même profil = même id : des envois simultanés partagent un seul envoi vers BRouter. */
function uploadProfile(base: string, profileId: string, profileText: string): Promise<UploadOutcome> {
  let job = PROFILE_UPLOADS_IN_FLIGHT.get(profileId);
  if (!job) {
    job = uploadProfileOnce(base, profileId, profileText).finally(() => PROFILE_UPLOADS_IN_FLIGHT.delete(profileId));
    PROFILE_UPLOADS_IN_FLIGHT.set(profileId, job);
  }
  return job;
}

/**
 * Erreur de routage due au fichier manquant d'un profil déjà accepté (dossier
 * des profils de BRouter vidé, autre instance) : le profil est renvoyé depuis
 * KNOWN_PROFILES. Vrai quand la requête peut être rejouée.
 */
async function restoreMissingProfile(base: string, profile: string | null, body: string): Promise<boolean> {
  if (!profile?.startsWith(CUSTOM_PROFILE_PREFIX)) return false;
  // Erreur en texte court, jamais un tracé (GeoJSON).
  if (body.length > 4_000 || body.trimStart().startsWith('{')) return false;
  // BExpressionContext.parseFile : « profile <empreinte>.brf does not exist ».
  const hash = profile.slice(CUSTOM_PROFILE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(hash) || !new RegExp(`${hash}(?:\\.brf)? does not exist`).test(body)) return false;
  const profileText = KNOWN_PROFILES.get(profile);
  if (profileText === undefined) return false;
  KNOWN_PROFILES.delete(profile);
  console.warn(`[brouter] profile ${profile} missing upstream, uploading it again`);
  const outcome = await uploadProfile(base, profile, profileText);
  return outcome.kind === 'ok' && KNOWN_PROFILES.get(profile) !== undefined;
}

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
  const profileId = `${CUSTOM_PROFILE_PREFIX}${crypto.createHash('sha256').update(profileText, 'utf8').digest('hex').slice(0, 16)}`;

  // Déjà accepté par BRouter : rien à renvoyer (voir KNOWN_PROFILES).
  if (KNOWN_PROFILES.get(profileId) !== undefined) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Profile-Cache', 'HIT');
    return res.status(200).json({ profileid: profileId });
  }

  const outcome = await uploadProfile(base, profileId, profileText);
  if (outcome.waitedMs !== undefined) res.setHeader('X-Upstream-Wait-Ms', String(Math.round(outcome.waitedMs)));
  if (outcome.kind === 'busy') {
    res.setHeader('Retry-After', '5');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'BRouter busy, retry shortly' });
  }
  if (outcome.kind !== 'ok') {
    return res.status(outcome.kind === 'timeout' ? 504 : 502).json({
      error: outcome.kind === 'timeout'
        ? `BRouter profile upload timeout after ${UPLOAD_TIMEOUT_MS}ms`
        : 'BRouter upstream unreachable',
    });
  }
  const { upstreamRes, text } = outcome;

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
