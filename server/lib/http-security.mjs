// ---------------------------------------------------------------------------
// Primitives de sécurité HTTP partagées par `server.mjs` (prod) et le plugin
// `redviewDevApiPlugin` de `vite.config.ts` (dev), pour que les deux
// adaptateurs appliquent exactement les mêmes règles :
//   - normalisation des chemins (pas de `..` encodé, pas de `\0`) ;
//   - résolution `/api/<route>` → `api/<route>.ts` sans accès à `_lib/` ;
//   - lecture du corps de requête avec plafond (413) ;
//   - IP client fiable pour le rate limiting (XFF le plus à droite, CF
//     seulement si la connexion vient réellement de Cloudflare) ;
//   - rate limiter mémoire borné ;
//   - validation des tuiles XYZ et des sources LiDAR relayées (anti-SSRF).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createOldestKeyTaker } from './oldest-key.mjs';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Chemins ────────────────────────────────────────────────────────────────

/**
 * Décode un pathname et refuse tout ce qui pourrait sortir de l'arborescence
 * prévue. `new URL()` a déjà résolu les `..` littéraux ; il ne reste que les
 * formes encodées (`..%2f`, `%2e%2e`) qu'on rejette après décodage.
 * Retourne `null` si le chemin est invalide (→ 400).
 */
export function decodeSafePathname(rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  return decoded;
}

/** `child` est-il strictement dans `parentDir` (séparateur inclus) ? */
export function isInsideDir(parentDir, child) {
  return child.startsWith(parentDir.endsWith(path.sep) ? parentDir : parentDir + path.sep);
}

// Routes dont tout le sous-chemin est servi par un seul handler.
const API_PREFIX_ALIASES = ['openmeteo', 'weather', 'brouter'];
// Segments en minuscules/chiffres/tirets uniquement : exclut `_lib`, les
// fichiers cachés et toute extension.
const API_ROUTE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/i;

/**
 * Résout `/api/...` vers un fichier handler de `apiDir`.
 * Retourne `{ route, file, isAuth }` ou `null` si la route n'existe pas.
 *
 * `extension` : `.ts` (sources, dev et `npm start`) ou `.mjs` (build de prod,
 * `scripts/build/build-server.mjs`). `routes` : routes connues d'avance
 * (`listApiRoutes`) ; sans elles, l'existence du fichier est testée à chaque appel.
 *
 * @param {string} apiDir
 * @param {string} pathname
 * @param {{ extension?: string, routes?: Set<string> }} [options]
 */
export function resolveApiRoute(apiDir, pathname, { extension = '.ts', routes } = {}) {
  if (!pathname.startsWith('/api/')) return null;
  let route = pathname.slice('/api/'.length).replace(/\/+$/, '');
  for (const alias of API_PREFIX_ALIASES) {
    if (route === alias || route.startsWith(`${alias}/`)) {
      route = alias;
      break;
    }
  }
  if (!route || !API_ROUTE_RE.test(route)) return null;
  const file = path.resolve(apiDir, `${route}${extension}`);
  if (!isInsideDir(apiDir, file)) return null;
  if (routes ? !routes.has(route) : !fs.existsSync(file)) return null;
  return { route, file, isAuth: route.startsWith('auth/') };
}

/**
 * Routes servies par `apiDir` (fichiers `<route><extension>`), lues une fois :
 * le serveur de prod sert un build immuable, inutile de toucher le disque à
 * chaque requête. Même règle de nom que `resolveApiRoute` (ni `_lib`, ni
 * fichier caché, ni test).
 *
 * @param {string} apiDir
 * @param {string} extension
 * @returns {Set<string>}
 */
export function listApiRoutes(apiDir, extension) {
  const routes = new Set();
  if (!fs.existsSync(apiDir)) return routes;
  for (const entry of fs.readdirSync(apiDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const route = path.relative(apiDir, file).slice(0, -extension.length).split(path.sep).join('/');
    if (API_ROUTE_RE.test(route)) routes.add(route);
  }
  return routes;
}

// ── Corps de requête ───────────────────────────────────────────────────────

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const BODY_LIMITS = {
  poi: 512 * 1024,
  brouter: 512 * 1024,
};

export function bodyLimitFor(route) {
  return BODY_LIMITS[route] ?? DEFAULT_BODY_LIMIT;
}

/**
 * Lit le corps de la requête en refusant (HttpError 413) tout ce qui dépasse
 * `limit`, avant même d'avoir tout bufferisé.
 */
export async function readBodyLimited(req, limit) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return Buffer.alloc(0);

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, 'Payload Too Large');
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) throw new HttpError(413, 'Payload Too Large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

// ── IP du client ───────────────────────────────────────────────────────────

// Plages publiées sur https://www.cloudflare.com/ips/ — utilisées uniquement
// pour décider si `CF-Connecting-IP` peut être cru.
const CLOUDFLARE_RANGES = new net.BlockList();
for (const cidr of [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]) {
  const [addr, prefix] = cidr.split('/');
  CLOUDFLARE_RANGES.addSubnet(addr, Number(prefix), 'ipv4');
}
for (const cidr of [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]) {
  const [addr, prefix] = cidr.split('/');
  CLOUDFLARE_RANGES.addSubnet(addr, Number(prefix), 'ipv6');
}

function isCloudflareIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return CLOUDFLARE_RANGES.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

function stripV4Mapped(ip) {
  return (ip || '').replace(/^::ffff:/i, '').trim();
}

export function isPrivateOrLoopbackIp(ip) {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^fe80:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const match172 = ip.match(/^172\.(\d+)\./);
  if (match172) {
    const second = parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * IP du client réel.
 *
 * Derrière Traefik (Coolify), seule l'entrée la PLUS À DROITE de
 * `X-Forwarded-For` est fiable : c'est celle que Traefik ajoute (le pair TCP
 * qu'il a vu). Les entrées de gauche sont fournies par le client et donc
 * falsifiables. `CF-Connecting-IP` n'est cru que si ce pair est lui-même une
 * IP Cloudflare — sinon n'importe qui pourrait l'envoyer pour contourner le
 * rate limiting.
 */
export function getClientIp(req) {
  const socketIp = stripV4Mapped(req.socket?.remoteAddress);
  if (!isPrivateOrLoopbackIp(socketIp)) return socketIp || '0.0.0.0';

  const xff = req.headers['x-forwarded-for'];
  const xffList = (Array.isArray(xff) ? xff.join(',') : xff || '')
    .split(',')
    .map((entry) => stripV4Mapped(entry))
    .filter((entry) => net.isIP(entry));
  const peerIp = xffList.length > 0 ? xffList[xffList.length - 1] : socketIp;

  if (isCloudflareIp(peerIp)) {
    const cf = req.headers['cf-connecting-ip'];
    const cfIp = typeof cf === 'string' ? stripV4Mapped(cf) : '';
    if (net.isIP(cfIp)) return cfIp;
  }
  return peerIp || socketIp || '0.0.0.0';
}

/** Une IPv6 = un /64 (un client contrôle généralement tout son /64). */
export function rateLimitKeyForIp(ip) {
  if (net.isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = ip.includes('::')
    ? [...headParts, ...Array(missing).fill('0'), ...tailParts]
    : headParts;
  return `${full.slice(0, 4).map((part) => part || '0').join(':')}::/64`;
}

// ── Limitation de débit ────────────────────────────────────────────────────

/**
 * Fenêtre fixe en mémoire, bornée à `maxKeys` entrées (les plus anciennes
 * sont évincées) pour qu'un flot d'IP différentes ne fasse pas grossir la
 * Map indéfiniment.
 */
export function createRateLimiter({ windowMs = 60_000, maxKeys = 50_000 } = {}) {
  const records = new Map();
  const takeOldestKey = createOldestKeyTaker(records);

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of records) {
      if (now > record.resetTime) records.delete(key);
    }
  }, 5 * 60_000);
  if (typeof sweep.unref === 'function') sweep.unref();

  return function hit(key, max) {
    const now = Date.now();
    let record = records.get(key);
    if (!record || now > record.resetTime) {
      records.delete(key);
      record = { count: 0, resetTime: now + windowMs };
      records.set(key, record);
      while (records.size > maxKeys) {
        records.delete(takeOldestKey());
      }
    }
    record.count += 1;
    return record.count <= max;
  };
}

// ── En-têtes ───────────────────────────────────────────────────────────────

/** En-têtes de durcissement posés sur TOUTES les réponses (API, tuiles, statique). */
export function applyBaseSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(self "https://js.stripe.com"), geolocation=(self)');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

// ── Tuiles ─────────────────────────────────────────────────────────────────

export const MAX_TILE_ZOOM = 22;

export function parseTileCoords(pathname, prefixRe) {
  const match = pathname.match(prefixRe);
  if (!match) return null;
  const z = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) return null;
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return null;
  return { z, x, y };
}

// ── Proxy nuages de points (/api/pointcloud) ───────────────────────────────

/**
 * Sources LiDAR sans en-têtes CORS, relayées par `/api/pointcloud` : hôte
 * exact et forme de chemin imposés (sous-dalles AHN de GeoTiles, morceaux de
 * bandes DHMV II d'EODaS OpenLidar). Toute autre URL est refusée (SSRF).
 */
const POINTCLOUD_UPSTREAMS = [
  { origin: 'https://geotiles.citg.tudelft.nl', path: /^\/AHN[45]_T\/\d{2}[A-H][NZ][12]_\d{2}\.LAZ$/ },
  { origin: 'https://remotesensing.vlaanderen.be', path: /^\/download\/openlidar\/LiDAR_DHMV_2_V2(?:\/[\w-]+)+\.laz$/i },
];

/** URL amont autorisée (normalisée), ou null. */
export function resolvePointcloudUpstream(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 400) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || url.port) return null;
  const rule = POINTCLOUD_UPSTREAMS.find(({ origin }) => origin === url.origin);
  if (!rule || !rule.path.test(url.pathname)) return null;
  return `${url.origin}${url.pathname}`;
}

/** En-tête `Range` relayé tel quel s'il est simple (`bytes=a-b`, une seule plage). */
export function sanitizeRangeHeader(raw) {
  return typeof raw === 'string' && /^bytes=\d{0,15}-\d{0,15}$/.test(raw) && raw !== 'bytes=-' ? raw : null;
}
