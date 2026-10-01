import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recolorRadarPng } from './server/radar-recolor.mjs';
import { generateSlopeTile, generateAltitudeTile } from './server/terrain-tiles.mjs';
import {
  HttpError,
  applyBaseSecurityHeaders,
  bodyLimitFor,
  buildRadarUpstreamUrl,
  createRateLimiter,
  decodeSafePathname,
  getClientIp,
  isInsideDir,
  parseTileCoords,
  rateLimitKeyForIp,
  readBodyLimited,
  resolveApiRoute,
} from './server/http-security.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const DIST_DIR = path.resolve(__dirname, 'dist');
const API_DIR = path.resolve(__dirname, 'api');

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
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.txt', '.brf']);
const MIN_COMPRESS_BYTES = 1024;
// Au-delà, on diffuse le fichier brut en flux plutôt que de le bufferiser.
const MAX_COMPRESS_BYTES = 32 * 1024 * 1024;
// Brotli 9 : bon ratio, ~0,3 s pour 3 MB ; 5 au-delà de 8 MB (chunk d'index LiDAR NZ).
const BROTLI_HIGH_QUALITY_MAX_BYTES = 8 * 1024 * 1024;
// Cache mémoire LRU des variantes compressées, borné en octets. Clé incluant
// taille + mtime : un fichier remplacé n'est jamais servi périmé.
const COMPRESSED_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const compressedCache = new Map();
const compressionsInFlight = new Map();
let compressedCacheBytes = 0;

export const REDVIEW_CSP_HEADER = [
  "default-src 'self'",
  // Aucun script inline dans index.html / viewer.html : pas de 'unsafe-inline'.
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://api.mapbox.com https://js.stripe.com https://analytics.redview.tech",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://api.mapbox.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://appwrite.redview.tech https://*.tilecache.rainviewer.com https://*.rainviewer.com https://*.rainviewer.net https://api.mapbox.com https://*.mapbox.com https://s3.amazonaws.com/elevation-tiles-prod/ https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com https://data.geopf.fr https://*.geopf.fr https://data.geo.admin.ch https://*.geo.admin.ch https://*.admin.ch https://servicios.idee.es https://*.idee.es https://www.ign.es https://*.ign.es https://hoydedata.no https://*.hoydedata.no https://cyberjapandata.gsi.go.jp https://*.gsi.go.jp https://server.arcgisonline.com https://*.arcgisonline.com",
  "connect-src 'self' blob: data: https://appwrite.redview.tech https://errors.redview.tech https://api.stripe.com https://api.mapbox.com https://events.mapbox.com https://*.mapbox.com https://*.rainviewer.com https://*.rainviewer.net https://api.open-meteo.com https://climate-api.open-meteo.com https://*.open-meteo.com https://nominatim.openstreetmap.org https://analytics.redview.tech https://s3.amazonaws.com/elevation-tiles-prod/ https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com https://opentopography.s3.sdsc.edu https://data.geopf.fr https://*.geopf.fr https://data.geo.admin.ch https://*.geo.admin.ch https://*.admin.ch https://servicios.idee.es https://*.idee.es https://www.ign.es https://*.ign.es https://hoydedata.no https://*.hoydedata.no https://cyberjapandata.gsi.go.jp https://*.gsi.go.jp https://server.arcgisonline.com https://*.arcgisonline.com",
  "frame-src https://js.stripe.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

// Rate limiting en mémoire (fenêtre d'une minute, Map bornée).
const hitRateLimit = createRateLimiter({ windowMs: 60 * 1000 });
const MAX_AUTH_REQUESTS = 15;
const MAX_API_REQUESTS = 120;
// Fallbacks de tuiles (SW inactif) : généreux, mais chaque requête déclenche
// des fetchs upstream, donc pas illimité.
const MAX_TILE_REQUESTS = 600;

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
 * Choisit l'encodage d'après Accept-Encoding (q-values respectées, `*`
 * compris) : brotli de préférence, sinon gzip, sinon identité (null).
 */
function negotiateEncoding(acceptEncoding) {
  if (!acceptEncoding) return null;
  const weights = new Map();
  for (const part of String(acceptEncoding).split(',')) {
    const [rawToken, ...params] = part.split(';');
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (m) q = Number(m[1]);
    }
    weights.set(token, Number.isFinite(q) ? q : 0);
  }
  const weightOf = (encoding) => weights.get(encoding) ?? weights.get('*') ?? 0;
  const br = weightOf('br');
  const gzip = weightOf('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

/** Variante compressée d'un fichier, mise en cache (LRU borné, dédoublonnage des compressions concurrentes). */
function getCompressedFile(filePath, stat, encoding) {
  const key = `${encoding}:${stat.size}:${Math.floor(stat.mtimeMs)}:${filePath}`;
  const cached = compressedCache.get(key);
  if (cached) {
    compressedCache.delete(key);
    compressedCache.set(key, cached);
    return Promise.resolve(cached);
  }
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
    if (compressed.length <= COMPRESSED_CACHE_MAX_BYTES / 4) {
      compressedCache.set(key, compressed);
      compressedCacheBytes += compressed.length;
      while (compressedCacheBytes > COMPRESSED_CACHE_MAX_BYTES && compressedCache.size > 0) {
        const [oldestKey, oldest] = compressedCache.entries().next().value;
        compressedCache.delete(oldestKey);
        compressedCacheBytes -= oldest.length;
      }
    }
    return compressed;
  })().finally(() => compressionsInFlight.delete(key));
  compressionsInFlight.set(key, work);
  return work;
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

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.statusCode = 400;
      return res.end('Bad Request');
    }

    applyBaseSecurityHeaders(res);

    const parsedUrl = new URL(req.url, 'http://localhost');
    let pathname = decodeSafePathname(parsedUrl.pathname);
    if (pathname === null) {
      res.statusCode = 400;
      return res.end('Bad Request');
    }

    // 0. Health check endpoint for uptime monitoring & Docker
    if (pathname === '/health' || pathname === '/healthz' || pathname === '/api/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), timestamp: Date.now() }));
    }

    // 1. Rewrite /viewer to /viewer.html
    if (pathname === '/viewer') {
      pathname = '/viewer.html';
    }

    // 2. Handle /api/* routes with rate limiting
    if (pathname.startsWith('/api/')) {
      const apiRoute = resolveApiRoute(API_DIR, pathname);
      // Le bucket est choisi d'après la route RÉSOLUE : un chemin détourné ne
      // peut plus atteindre `auth/*` en passant par le quota général.
      const isAuth = apiRoute?.isAuth ?? false;
      if (!checkRateLimit(req, isAuth ? 'auth' : 'general', isAuth ? MAX_AUTH_REQUESTS : MAX_API_REQUESTS)) {
        return sendTooManyRequests(res);
      }
      if (!apiRoute) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ error: 'API route not found' }));
      }
      return await handleApiRoute(apiRoute, parsedUrl, req, res);
    }

    if (
      pathname.startsWith('/radar-tiles/')
      || pathname.startsWith('/slope-tiles/')
      || pathname.startsWith('/altitude-tiles/')
      || pathname.startsWith('/dem-tiles/')
    ) {
      if (!checkRateLimit(req, 'tiles', MAX_TILE_REQUESTS)) {
        return sendTooManyRequests(res);
      }
    }

    // 2b. Fallback proxy for /radar-tiles/* when Service Worker is inactive (e.g. over plain HTTP)
    if (pathname.startsWith('/radar-tiles/')) {
      return await handleRadarTileRoute(pathname, parsedUrl, req, res);
    }

    // 2c. Fallback for /slope-tiles/* when Service Worker is inactive (e.g. over plain HTTP)
    if (pathname.startsWith('/slope-tiles/')) {
      return await handleSlopeTileRoute(pathname, parsedUrl, req, res);
    }

    // 2d. Fallback for /altitude-tiles/* and /dem-tiles/* when Service Worker is inactive (e.g. over plain HTTP)
    if (pathname.startsWith('/altitude-tiles/') || pathname.startsWith('/dem-tiles/')) {
      return await handleAltitudeTileRoute(pathname, parsedUrl, req, res);
    }

    // 3. Serve Static Files from dist (lecture seule : GET/HEAD uniquement)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Method Not Allowed');
    }

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
      // Navigation -> SPA fallback to dist/index.html
      filePath = path.join(DIST_DIR, 'index.html');
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        res.statusCode = 404;
        return res.end('Not Found (dist/index.html missing)');
      }
    }

    // Set cache headers
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

    const compressible = COMPRESSIBLE_EXTENSIONS.has(ext)
      && stat.size >= MIN_COMPRESS_BYTES
      && stat.size <= MAX_COMPRESS_BYTES;
    const encoding = compressible ? negotiateEncoding(req.headers['accept-encoding']) : null;
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

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('Static stream error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }
});

async function handleApiRoute(apiRoute, parsedUrl, req, res) {
  const { route, file: candidateFile } = apiRoute;

  // Parse Query Parameters
  const query = {};
  for (const [key, value] of parsedUrl.searchParams.entries()) {
    if (key in query) {
      const existing = query[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    } else {
      query[key] = value;
    }
  }

  // Parse Request Body (plafonné : 413 avant d'avoir tout bufferisé)
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
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  let parsedBody = rawBody;

  if (contentType.includes('application/json')) {
    try {
      parsedBody = rawBody.length > 0 ? JSON.parse(rawBody.toString('utf-8')) : {};
    } catch {
      parsedBody = rawBody.toString('utf-8');
    }
  } else if (contentType.includes('text/') || contentType.includes('application/x-www-form-urlencoded')) {
    parsedBody = rawBody.toString('utf-8');
  }

  // Build ApiRequest
  const apiReq = Object.assign(req, {
    query,
    cookies: {},
    body: parsedBody,
    [Symbol.asyncIterator]: async function* () {
      yield rawBody;
    },
  });

  // Build ApiResponse
  const apiRes = Object.assign(res, {
    status(code) {
      res.statusCode = code;
      return apiRes;
    },
    json(data) {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify(data));
      return apiRes;
    },
    send(data) {
      if (Buffer.isBuffer(data)) {
        res.end(data);
      } else if (typeof data === 'string') {
        if (!res.headersSent && !res.getHeader('Content-Type')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        }
        res.end(data);
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
    console.error(`[API Error ${route}]:`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      const safeMessage = process.env.NODE_ENV === 'production'
        ? 'Internal Server Error'
        : (err.message || 'Internal Server Error');
      res.end(JSON.stringify({ error: safeMessage }));
    }
  }
}

async function handleRadarTileRoute(pathname, parsedUrl, req, res) {
  const coords = parseTileCoords(pathname, /^\/radar-tiles\/(\d+)\/(\d+)\/(\d+)/);
  // Hôte forcé dans l'allowlist, chemin de frame strictement alphanumérique.
  const target = coords ? buildRadarUpstreamUrl(parsedUrl.searchParams, coords) : null;
  if (!target) {
    res.statusCode = 400;
    return res.end('Invalid radar tile request');
  }
  try {
    const pStr = parsedUrl.searchParams.get('p') || '';
    const upstreamRes = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    const upstreamType = upstreamRes.headers.get('content-type') || '';
    if (upstreamRes.ok && upstreamType.startsWith('image/')) {
      const rawBuf = Buffer.from(await upstreamRes.arrayBuffer());
      const finalBuf = pStr ? recolorRadarPng(rawBuf, pStr) : rawBuf;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Weather-Source', pStr ? 'server-radar-recolor' : 'server-radar-proxy');
      return res.end(finalBuf);
    }
  } catch (e) {
    console.warn('[server-radar-tiles] error:', e);
  }
  res.statusCode = 204;
  return res.end();
}

async function handleSlopeTileRoute(pathname, parsedUrl, req, res) {
  try {
    const coords = parseTileCoords(pathname, /^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/);
    if (coords) {
      const pngBuf = await generateSlopeTile(coords.z, coords.x, coords.y);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Tile-Type', 'slope');
      return res.end(pngBuf);
    }
  } catch (e) {
    console.warn('[server-slope-tiles] error:', e);
  }
  res.statusCode = 204;
  return res.end();
}

async function handleAltitudeTileRoute(pathname, parsedUrl, req, res) {
  try {
    const coords = parseTileCoords(pathname, /^\/(?:altitude|dem)-tiles\/(\d+)\/(\d+)\/(\d+)/);
    if (coords) {
      const pngBuf = await generateAltitudeTile(coords.z, coords.x, coords.y);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Tile-Type', 'altitude');
      return res.end(pngBuf);
    }
  } catch (e) {
    console.warn('[server-altitude-tiles] error:', e);
  }
  res.statusCode = 204;
  return res.end();
}

export { server };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  // Slowloris : en-têtes en 20 s max, requête complète en 120 s max
  // (les proxies Overpass/BRouter ont leurs propres timeouts < 90 s).
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[RedView Server] Running on http://0.0.0.0:${PORT}`);
  });
}

