import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { recolorRadarPng } from './server/radar-recolor.mjs';
import { generateSlopeTile, generateAltitudeTile } from './server/terrain-tiles.mjs';

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
};

// In-memory rate limiting map: ip -> { count, resetTime }
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_AUTH_REQUESTS = 15;
const MAX_API_REQUESTS = 120;

function checkRateLimit(req, isAuth) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
  const key = `${ip}:${isAuth ? 'auth' : 'general'}`;
  const max = isAuth ? MAX_AUTH_REQUESTS : MAX_API_REQUESTS;
  const now = Date.now();

  const record = rateLimitMap.get(key) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + RATE_LIMIT_WINDOW_MS;
  }

  record.count += 1;
  rateLimitMap.set(key, record);

  return record.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.statusCode = 400;
      return res.end('Bad Request');
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);

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
      const isAuth = pathname.startsWith('/api/auth');
      if (!checkRateLimit(req, isAuth)) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Retry-After', '60');
        return res.end(JSON.stringify({ error: 'Trop de requêtes. Veuillez patienter une minute.' }));
      }
      return await handleApiRoute(pathname, parsedUrl, req, res);
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

    // 3. Serve Static Files from dist
    let filePath = path.join(DIST_DIR, pathname);

    // Prevent path traversal
    if (!filePath.startsWith(DIST_DIR)) {
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
      // File not found -> SPA fallback to dist/index.html
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

    if (pathname.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (pathname === '/index.html' || pathname === '/viewer.html' || filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }
});

async function handleApiRoute(pathname, parsedUrl, req, res) {
  // Normalize openmeteo & weather
  let apiPath = pathname;
  if (apiPath.startsWith('/api/openmeteo')) {
    apiPath = '/api/openmeteo';
  } else if (apiPath.startsWith('/api/weather')) {
    apiPath = '/api/weather';
  }

  const relPath = apiPath.replace(/^\/api\//, '');
  const candidateFile = path.resolve(API_DIR, `${relPath}.ts`);

  if (!candidateFile.startsWith(API_DIR) || !fs.existsSync(candidateFile)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: `API route ${pathname} not found` }));
  }

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

  // Parse Request Body
  const chunks = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }
  const rawBody = Buffer.concat(chunks);
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
      res.end(JSON.stringify({ error: `Handler in ${relPath}.ts is not a function` }));
    }
  } catch (err) {
    console.error(`[API Error ${pathname}]:`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
    }
  }
}

async function handleRadarTileRoute(pathname, parsedUrl, req, res) {
  try {
    const host = decodeURIComponent(parsedUrl.searchParams.get('host') || 'https://tilecache.rainviewer.com').replace(/\/+$/, '');
    const framePath = decodeURIComponent(parsedUrl.searchParams.get('path') || '');
    const pStr = parsedUrl.searchParams.get('p') || '';
    const match = pathname.match(/^\/radar-tiles\/(\d+)\/(\d+)\/(\d+)/);
    if (match && framePath) {
      const [, z, x, y] = match;
      const cleanPath = framePath.startsWith('/') ? framePath : `/${framePath}`;
      const target = `${host}${cleanPath}/512/${z}/${x}/${y}/2/1_1.png`;
      const upstreamRes = await fetch(target);
      if (upstreamRes.ok) {
        const rawBuf = Buffer.from(await upstreamRes.arrayBuffer());
        const finalBuf = pStr ? recolorRadarPng(rawBuf, pStr) : rawBuf;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Weather-Source', pStr ? 'server-radar-recolor' : 'server-radar-proxy');
        return res.end(finalBuf);
      }
    }
  } catch (e) {
    console.warn('[server-radar-tiles] error:', e);
  }
  res.statusCode = 204;
  return res.end();
}

async function handleSlopeTileRoute(pathname, parsedUrl, req, res) {
  try {
    const match = pathname.match(/^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/);
    if (match) {
      const [, z, x, y] = match;
      const pngBuf = await generateSlopeTile(parseInt(z, 10), parseInt(x, 10), parseInt(y, 10));
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
    const match = pathname.match(/^\/(?:altitude|dem)-tiles\/(\d+)\/(\d+)\/(\d+)/);
    if (match) {
      const [, z, x, y] = match;
      const pngBuf = await generateAltitudeTile(parseInt(z, 10), parseInt(x, 10), parseInt(y, 10));
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RedView Server] Running on http://0.0.0.0:${PORT}`);
});
