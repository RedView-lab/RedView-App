import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.statusCode = 400;
      return res.end('Bad Request');
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(parsedUrl.pathname);

    // 1. Rewrite /viewer to /viewer.html
    if (pathname === '/viewer') {
      pathname = '/viewer.html';
    }

    // 2. Handle /api/* routes
    if (pathname.startsWith('/api/')) {
      return await handleApiRoute(pathname, parsedUrl, req, res);
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
  // Normalize openmeteo
  let apiPath = pathname;
  if (apiPath.startsWith('/api/openmeteo')) {
    apiPath = '/api/openmeteo';
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
    const mod = await import(candidateFile);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RedView Server] Running on http://0.0.0.0:${PORT}`);
});
