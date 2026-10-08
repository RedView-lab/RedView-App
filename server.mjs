import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseApiBody, parseApiQuery } from './server/lib/api-request.mjs';
import { createByteLru } from './server/lib/byte-lru.mjs';
import {
  HttpError,
  applyBaseSecurityHeaders,
  bodyLimitFor,
  createRateLimiter,
  decodeSafePathname,
  getClientIp,
  isInsideDir,
  listApiRoutes,
  rateLimitKeyForIp,
  readBodyLimited,
  resolveApiRoute,
} from './server/lib/http-security.mjs';
import { serveTileFallback, tileFallbackFamily, tileFallbackHitsUpstream } from './server/lib/tile-fallbacks.mjs';
import { captureServerError, flushServerObservability, initServerObservability } from './server/lib/observability.mjs';
import { createRequestLogger, normalizeRoutePath } from './server/lib/request-logging.mjs';
import { VARIANT_SUFFIX, acceptedEncodings, isCompressible } from './server/lib/static-compression.mjs';
import { REDVIEW_CSP_HEADER } from './server/lib/csp.mjs';
import { resolveLegacyAssetPath } from './server/lib/legacy-asset-paths.mjs';
import { API_COMPRESS_SYNC_MAX_BYTES, compressApiBody, compressApiBodySync, pickApiEncoding, withVary } from './server/lib/api-compression.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);

// Image de prod : server.mjs et les routes api/ sont bundlés dans dist-server/
// (scripts/build/build-server.mjs), les routes en `.mjs`, sans tsx. La constante est
// remplacée à la compilation ; non bundlé (`npm start`, tests), le serveur
// charge les sources `.ts`.
const BUNDLED = process.env.REDVIEW_SERVER_BUNDLE === '1';
const ROOT_DIR = BUNDLED ? path.resolve(__dirname, '..') : __dirname;
const DIST_DIR = path.resolve(ROOT_DIR, 'dist');
const API_DIR = BUNDLED ? path.resolve(__dirname, 'api') : path.resolve(ROOT_DIR, 'api');
const API_ROUTE_OPTIONS = BUNDLED
  ? { extension: '.mjs', routes: listApiRoutes(API_DIR, '.mjs') }
  : { extension: '.ts' };

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.brf': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// ── Compression des statiques (le proxy amont ne compresse pas) ─────────────
const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

/**
 * Variantes précompressées du build (scripts/build/precompress-dist.mjs, lancé dans
 * l'image) : chemin de la variante → taille et date. Lues une fois, le build
 * est immuable ; la prod ne compresse donc rien à l'exécution (ni CPU, ni
 * cache mémoire). Un fichier sans variante y est servi tel quel : trop petit,
 * ou la compression n'y gagnait pas assez.
 */
function scanPrecompressedVariants(dir) {
  const variants = new Map();
  if (!fs.existsSync(dir)) return variants;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(br|gz)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const { size, mtimeMs } = fs.statSync(file);
    variants.set(file, { size, mtimeMs });
  }
  return variants;
}
const PRECOMPRESSED_VARIANTS = scanPrecompressedVariants(DIST_DIR);

// Compression à la volée : seulement sans build précompressé (`npm start` en
// local). Brotli 9 : bon ratio, ~0,3 s pour 3 MB ; 5 au-delà de 8 MB.
const COMPRESS_ON_THE_FLY = PRECOMPRESSED_VARIANTS.size === 0;
const BROTLI_HIGH_QUALITY_MAX_BYTES = 8 * 1024 * 1024;
// Cache LRU des variantes compressées à la volée, borné en octets. Clé
// incluant taille + mtime : un fichier remplacé n'est jamais servi périmé.
const compressedCache = createByteLru({ maxBytes: 16 * 1024 * 1024, sizeOf: (body) => body.length });
const compressionsInFlight = new Map();

export { REDVIEW_CSP_HEADER };

// Rate limiting en mémoire (fenêtre d'une minute, Map bornée).
const hitRateLimit = createRateLimiter({ windowMs: 60 * 1000 });
const MAX_AUTH_REQUESTS = 15;
const MAX_API_REQUESTS = 120;
// Tuiles/méta météo du VPS (/api/weather/*) : un balayage de 24 h × 5 couches
// avec préchargement fait ~145 requêtes ; bucket dédié pour ne pas épuiser
// celui de BRouter/POI.
const MAX_WEATHER_REQUESTS = 600;
// Fallbacks de tuiles (SW inactif) : généreux, mais chaque requête déclenche
// des fetchs upstream, donc pas illimité. Quota par famille (radar, slope,
// altitude) ; /dem-tiles et les préchargements `?pf=1` ne sont pas comptés.
const MAX_TILE_REQUESTS = 600;
// Proxy LiDAR (/api/pointcloud) : un fichier par dalle (Pays-Bas) ou par
// morceau de bande (Flandre, ≤ 10 par cellule), plus les reprises Range ;
// bucket dédié pour qu'une série de téléchargements n'épuise pas le quota
// général (BRouter, POI…).
const MAX_POINTCLOUD_REQUESTS = 120;
// Actions de facturation (POST /api/billing/*) : chaque souscription crée des
// objets chez Stripe ; un parcours complet en fait moins de 10. Les lectures
// (GET overview) restent sur le quota général.
const MAX_BILLING_REQUESTS = 30;
// Webhook Stripe : Stripe livre en rafales depuis quelques IP (horloges de
// test, relivraisons) ; un 429 retarderait les e-mails d'abonnement.
const MAX_STRIPE_WEBHOOK_REQUESTS = 600;

function checkRateLimit(req, bucket, max) {
  const ipKey = rateLimitKeyForIp(getClientIp(req));
  return hitRateLimit(`${ipKey}:${bucket}`, max);
}

/**
 * Chemin d'asset (et non de navigation SPA) : tout `/assets/*` et tout chemin
 * dont le dernier segment porte une extension. Les URLs de projet
 * (`/project/<slug>--<id>`) restent des navigations même si l'id contient
 * un point.
 */
function looksLikeStaticAsset(pathname) {
  if (pathname.startsWith('/assets/')) return true;
  if (pathname.startsWith('/project/')) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]+$/i.test(lastSegment);
}

/**
 * Variante précompressée à servir pour `filePath` : la première acceptée par
 * le client, jamais plus ancienne que le fichier (variante d'un build précédent).
 */
function pickPrecompressedVariant(filePath, stat, encodings) {
  for (const encoding of encodings) {
    const file = filePath + VARIANT_SUFFIX[encoding];
    const variant = PRECOMPRESSED_VARIANTS.get(file);
    if (variant && variant.mtimeMs >= stat.mtimeMs) return { encoding, file, size: variant.size };
  }
  return null;
}

/** Variante compressée d'un fichier, mise en cache (LRU borné, dédoublonnage des compressions concurrentes). */
function getCompressedFile(filePath, stat, encoding) {
  const key = `${encoding}:${stat.size}:${Math.floor(stat.mtimeMs)}:${filePath}`;
  const cached = compressedCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = compressionsInFlight.get(key);
  if (inFlight) return inFlight;

  const work = (async () => {
    const raw = await fs.promises.readFile(filePath);
    const compressed = encoding === 'br'
      ? await brotliCompressAsync(raw, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > BROTLI_HIGH_QUALITY_MAX_BYTES ? 5 : 9,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
        },
      })
      : await gzipAsync(raw, { level: 9 });
    compressedCache.set(key, compressed);
    return compressed;
  })().finally(() => compressionsInFlight.delete(key));
  compressionsInFlight.set(key, work);
  return work;
}

/** Diffuse un fichier en flux ; une erreur de lecture répond 500 (ou coupe la réponse déjà commencée). */
function streamFile(filePath, req, res) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    req.log.error({ err }, 'static stream error');
    captureServerError(err, { route: req.redviewRoute, requestId: req.id, method: req.method });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
}

/** ETag faible dérivé de la taille et de la date de modification. */
function buildStaticEtag(stat, variant = '') {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${variant ? `-${variant}` : ''}"`;
}

/** Requête conditionnelle satisfaite (If-None-Match prioritaire sur If-Modified-Since) ? */
function isNotModified(req, etag, mtime) {
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch) {
    const normalise = (tag) => tag.trim().replace(/^W\//, '');
    const wanted = normalise(etag);
    return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || normalise(tag) === wanted);
  }
  const ifModifiedSince = req.headers['if-modified-since'];
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) <= Math.floor(since / 1000);
  }
  return false;
}

function sendTooManyRequests(res) {
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Retry-After', '60');
  return res.end(JSON.stringify({ error: 'Trop de requêtes. Veuillez patienter une minute.' }));
}

initServerObservability();
const logRequest = createRequestLogger();

const server = http.createServer(async (req, res) => {
  // Pose req.id (X-Request-ID) et req.log ; la ligne est écrite à la fin de la réponse.
  logRequest(req, res);
  try {
    if (!req.url) {
      req.redviewRoute = normalizeRoutePath(null);
      res.statusCode = 400;
      return res.end('Bad Request');
    }

    applyBaseSecurityHeaders(res);

    const parsedUrl = new URL(req.url, 'http://localhost');
    let pathname = decodeSafePathname(parsedUrl.pathname);
    req.redviewRoute = normalizeRoutePath(pathname);
    if (pathname === null) {
      res.statusCode = 400;
      return res.end('Bad Request');
    }

    // 0. Point d'accès de santé pour la surveillance de disponibilité et Docker
    if (pathname === '/health' || pathname === '/healthz' || pathname === '/api/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), timestamp: Date.now() }));
    }

    // 1. Réécrit /viewer en /viewer.html
    if (pathname === '/viewer') {
      pathname = '/viewer.html';
    }

    // 2. Gère les routes /api/* avec limitation de débit
    if (pathname.startsWith('/api/')) {
      const apiRoute = resolveApiRoute(API_DIR, pathname, API_ROUTE_OPTIONS);
      req.redviewRoute = normalizeRoutePath(pathname, apiRoute?.route);
      // Le bucket est choisi d'après la route RÉSOLUE : un chemin détourné ne
      // peut plus atteindre `auth/*` en passant par le quota général.
      const isAuth = apiRoute?.isAuth ?? false;
      const isWeather = apiRoute?.route === 'weather';
      const isPointcloud = apiRoute?.route === 'pointcloud';
      const isBilling = req.method !== 'GET' && (apiRoute?.route.startsWith('billing/') ?? false);
      const isStripeWebhook = apiRoute?.route === 'stripe/webhook';
      const [bucket, max] = isAuth
        ? ['auth', MAX_AUTH_REQUESTS]
        : isWeather
          ? ['weather', MAX_WEATHER_REQUESTS]
          : isPointcloud
            ? ['pointcloud', MAX_POINTCLOUD_REQUESTS]
            : isBilling
              ? ['billing', MAX_BILLING_REQUESTS]
              : isStripeWebhook
                ? ['stripe-webhook', MAX_STRIPE_WEBHOOK_REQUESTS]
                : ['general', MAX_API_REQUESTS];
      if (!checkRateLimit(req, bucket, max)) {
        return sendTooManyRequests(res);
      }
      if (!apiRoute) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ error: 'API route not found' }));
      }
      return await handleApiRoute(apiRoute, parsedUrl, req, res);
    }

    // 2b. Tuiles servies normalement par le Service Worker, la page n'est pas
    // (encore) contrôlée (server/lib/tile-fallbacks.mjs). Celles qui sollicitent
    // un amont ont un quota PAR famille, pour qu'une rafale pente ne prive pas
    // l'altitude ou le radar (et inversement) ; les 204 immédiats sont hors quota.
    const tileFamily = tileFallbackFamily(pathname);
    if (tileFamily) {
      if (
        tileFallbackHitsUpstream(tileFamily, parsedUrl.searchParams)
        && !checkRateLimit(req, `tiles:${tileFamily}`, MAX_TILE_REQUESTS)
      ) {
        return sendTooManyRequests(res);
      }
      return await serveTileFallback(tileFamily, pathname, parsedUrl.searchParams, res);
    }

    // 3. Sert les fichiers statiques de dist (lecture seule : GET/HEAD uniquement)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Method Not Allowed');
    }

    // Sourcemaps : uploadées sur GlitchTip et supprimées au build, jamais servies.
    // Variantes précompressées (.br/.gz) : servies seulement par négociation.
    if (/\.(map|br|gz)$/.test(pathname)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end('Not Found');
    }

    // Fichiers de public/ déplacés : l'ancienne URL (onglet ouvert avant le
    // déploiement) sert le nouveau fichier (server/lib/legacy-asset-paths.mjs).
    pathname = resolveLegacyAssetPath(pathname) ?? pathname;

    let filePath = path.join(DIST_DIR, pathname);

    // Prevent path traversal (séparateur inclus : `dist_x/` n'est pas `dist/`)
    if (filePath !== DIST_DIR && !isInsideDir(DIST_DIR, filePath)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = await fs.promises.stat(filePath);
      }
    } catch {
      // Fichier absent. Un asset (chunk hashé d'un build précédent, .wasm,
      // .json…) doit répondre 404 : renvoyer index.html en 200 casserait le
      // chargement des chunks paresseux après un déploiement (le navigateur
      // recevrait du HTML à la place du JS/CSS). Le fallback SPA ne vaut que
      // pour les navigations sans extension.
      if (looksLikeStaticAsset(pathname)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end('Not Found');
      }
      // Navigation -> repli SPA sur dist/index.html
      filePath = path.join(DIST_DIR, 'index.html');
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        res.statusCode = 404;
        return res.end('Not Found (dist/index.html missing)');
      }
    }

    // En-têtes de cache
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    const isHtml = ext === '.html' || pathname === '/' || pathname === '/viewer' || filePath.endsWith('index.html') || filePath.endsWith('viewer.html');
    // Les fichiers de dist/assets/ sont tous hashés par Vite (workers compris) :
    // immuables. Les autres (public/) gardent un nom stable d'un build à l'autre.
    const isHashedAsset = pathname.startsWith('/assets/');
    const fetchDest = req.headers['sec-fetch-dest'];
    const isWorker = ext === '.js' && (
      pathname.toLowerCase().includes('worker')
      || pathname === '/sw-dem.js'
      || pathname.startsWith('/sw-dem/')
      || fetchDest === 'worker'
      || fetchDest === 'serviceworker'
      || fetchDest === 'sharedworker'
    );

    if (isHtml) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', REDVIEW_CSP_HEADER);
      res.setHeader('X-Frame-Options', 'DENY');
    } else if (isHashedAsset) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (isWorker) res.setHeader('Content-Security-Policy', REDVIEW_CSP_HEADER);
    } else if (isWorker) {
      // sw-dem.js et ses modules : nom stable, revalidés à chaque chargement.
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy', REDVIEW_CSP_HEADER);
    } else {
      // Statiques racine non hashés (.wasm, france-border.json, icônes…) :
      // 1 jour puis revalidation via ETag / Last-Modified.
      res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
    }

    const compressible = isCompressible(ext, stat.size);
    const encodings = compressible ? acceptedEncodings(req.headers['accept-encoding']) : [];
    const precompressed = pickPrecompressedVariant(filePath, stat, encodings);
    const encoding = precompressed?.encoding ?? (COMPRESS_ON_THE_FLY ? encodings[0] : undefined) ?? null;
    if (compressible) res.setHeader('Vary', 'Accept-Encoding');

    if (!isHtml) {
      // Une variante par encodage : l'ETag doit les distinguer.
      const etag = buildStaticEtag(stat, encoding ?? '');
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', stat.mtime.toUTCString());
      if (isNotModified(req, etag, stat.mtime)) {
        res.removeHeader('Content-Type');
        res.statusCode = 304;
        return res.end();
      }
    }

    if (precompressed) {
      res.setHeader('Content-Encoding', precompressed.encoding);
      res.setHeader('Content-Length', precompressed.size);
      return req.method === 'HEAD' ? res.end() : streamFile(precompressed.file, req, res);
    }

    if (encoding) {
      const body = await getCompressedFile(filePath, stat, encoding);
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', body.length);
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }

    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') {
      return res.end();
    }
    streamFile(filePath, req, res);
  } catch (err) {
    req.log.error({ err }, 'server error');
    captureServerError(err, { route: req.redviewRoute, requestId: req.id, method: req.method });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }
});

async function handleApiRoute(apiRoute, parsedUrl, req, res) {
  const { route, file: candidateFile } = apiRoute;

  // Corps plafonné : 413 avant d'avoir tout bufferisé.
  let rawBody;
  try {
    rawBody = await readBodyLimited(req, bodyLimitFor(route));
  } catch (err) {
    if (err instanceof HttpError) {
      res.statusCode = err.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      return res.end(JSON.stringify({ error: err.message }));
    }
    throw err;
  }
  // Construit l'ApiRequest
  const apiReq = Object.assign(req, {
    query: parseApiQuery(parsedUrl.searchParams),
    cookies: {},
    body: parseApiBody(rawBody, req.headers['content-type']),
    // X-Request-ID de la requête (journal, GlitchTip), à relayer aux services amont.
    requestId: req.id,
    [Symbol.asyncIterator]: async function* () {
      yield rawBody;
    },
  });

  // Corps d'un handler : compressé si le client l'accepte (server/lib/api-compression.mjs).
  // Un gros corps se compresse hors de la boucle d'événements : la réponse part
  // alors après le retour du handler (`bodyPending`).
  let bodyPending = false;
  function endApiBody(body) {
    const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    const encoding = res.headersSent ? null : pickApiEncoding({
      acceptEncoding: req.headers['accept-encoding'],
      contentType: res.getHeader('Content-Type'),
      contentEncoding: res.getHeader('Content-Encoding'),
      statusCode: res.statusCode,
      method: req.method,
      size: raw.length,
    });
    if (!encoding) {
      res.end(raw);
      return;
    }
    res.setHeader('Vary', withVary(res.getHeader('Vary'), 'Accept-Encoding'));
    const sendEncoded = (packed) => {
      if (res.writableEnded || res.destroyed) return;
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', packed.length);
      res.end(packed);
    };
    if (raw.length <= API_COMPRESS_SYNC_MAX_BYTES) {
      sendEncoded(compressApiBodySync(raw, encoding));
      return;
    }
    bodyPending = true;
    compressApiBody(raw, encoding).then(sendEncoded, (err) => {
      req.log.warn({ err }, 'api response compression failed');
      if (!res.writableEnded && !res.destroyed) res.end(raw);
    });
  }

  // Construit l'ApiResponse
  const apiRes = Object.assign(res, {
    status(code) {
      res.statusCode = code;
      return apiRes;
    },
    json(data) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      endApiBody(JSON.stringify(data));
      return apiRes;
    },
    send(data) {
      if (Buffer.isBuffer(data)) {
        endApiBody(data);
      } else if (typeof data === 'string') {
        if (!res.headersSent && !res.getHeader('Content-Type')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
        endApiBody(data);
      } else {
        apiRes.json(data);
      }
      return apiRes;
    },
    redirect(statusOrUrl, url) {
      if (typeof statusOrUrl === 'string') {
        res.writeHead(307, { Location: statusOrUrl });
      } else {
        res.writeHead(statusOrUrl, { Location: url });
      }
      res.end();
      return apiRes;
    },
  });

  try {
    const mod = await import(pathToFileURL(candidateFile).href);
    const handler = mod.default || mod;
    if (typeof handler === 'function') {
      await handler(apiReq, apiRes);
    } else {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  } catch (err) {
    req.log.error({ err, route: req.redviewRoute }, 'api handler error');
    captureServerError(err, { route: req.redviewRoute, requestId: req.id, method: req.method });
    if (!res.headersSent && !bodyPending) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      const safeMessage = process.env.NODE_ENV === 'production'
        ? 'Internal Server Error'
        : (err.message || 'Internal Server Error');
      res.end(JSON.stringify({ error: safeMessage }));
    }
  }
}

export { server };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // Slowloris : en-têtes en 20 s max, requête complète en 120 s max
  // (les proxies amont, BRouter compris, ont leurs propres timeouts < 90 s).
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[RedView Server] Running on http://0.0.0.0:${PORT}`);
  });
  // Arrêt du conteneur (node en PID 1) : erreurs en attente envoyées avant de sortir.
  process.once('SIGTERM', () => {
    server.close();
    void flushServerObservability(2000).finally(() => process.exit(0));
  });
}

