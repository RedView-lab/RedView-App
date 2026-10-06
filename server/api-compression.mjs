// ---------------------------------------------------------------------------
// Compression des réponses des routes `api/` en prod (server.mjs). Ni le nginx
// de l'hôte ni Traefik ne compressent, et seuls les statiques sont
// précompressés au build : les corps JSON/texte des handlers partaient bruts
// (le dictionnaire de traductions faisait 264 Kio ; POI, météo, grilles neige
// le long d'un tracé…). Un handler qui compresse déjà lui-même
// (api/brouter.ts, cache brotli) pose `Content-Encoding` : rien n'est refait.
// Le serveur de dev (plugin Vite) sert en local et ne compresse pas.
// ---------------------------------------------------------------------------
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { acceptedEncodings } from './static-compression.mjs';

const MIN_BYTES = 1024;
const MAX_BYTES = 32 * 1024 * 1024;
/**
 * Jusqu'ici le corps est compressé tout de suite (≲ 0,5 ms) : la réponse part
 * pendant l'appel du handler, comme sans compression. Au-delà, sur le pool de
 * libuv, pour ne pas bloquer la boucle d'événements.
 */
export const API_COMPRESS_SYNC_MAX_BYTES = 64 * 1024;
const COMPRESSIBLE_TYPE_RE = /^\s*(?:text\/|application\/(?:json|[\w.-]+\+json|javascript|xml|[\w.-]+\+xml|x-ndjson)\b|image\/svg\+xml)/i;

// Brotli 4 : contenu dynamique (264 Kio de JSON → 60 Kio en ~2 ms, quand la
// qualité 9 des statiques donne 49 Kio en 13 ms). Gzip 6 pour les rares
// clients sans brotli.
const brotliOptions = (size) => ({
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
  },
});
const GZIP_OPTIONS = { level: 6 };
const brotliAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

/**
 * Encodage à appliquer au corps d'une réponse API, ou null (identité).
 *
 * @param {object} response
 * @param {string | string[] | undefined} response.acceptEncoding en-tête Accept-Encoding de la requête
 * @param {unknown} response.contentType Content-Type posé par le handler
 * @param {unknown} response.contentEncoding Content-Encoding déjà posé par le handler
 * @param {number} response.statusCode
 * @param {string | undefined} response.method
 * @param {number} response.size taille du corps (octets)
 * @returns {'br' | 'gzip' | null}
 */
export function pickApiEncoding({ acceptEncoding, contentType, contentEncoding, statusCode, method, size }) {
  if (method === 'HEAD' || statusCode === 204 || statusCode === 304) return null;
  if (contentEncoding) return null;
  if (size < MIN_BYTES || size > MAX_BYTES) return null;
  if (typeof contentType !== 'string' || !COMPRESSIBLE_TYPE_RE.test(contentType)) return null;
  return acceptedEncodings(acceptEncoding)[0] ?? null;
}

/**
 * @param {Buffer} body
 * @param {'br' | 'gzip'} encoding
 * @returns {Buffer}
 */
export function compressApiBodySync(body, encoding) {
  return encoding === 'br' ? zlib.brotliCompressSync(body, brotliOptions(body.length)) : zlib.gzipSync(body, GZIP_OPTIONS);
}

/**
 * @param {Buffer} body
 * @param {'br' | 'gzip'} encoding
 * @returns {Promise<Buffer>}
 */
export function compressApiBody(body, encoding) {
  return encoding === 'br' ? brotliAsync(body, brotliOptions(body.length)) : gzipAsync(body, GZIP_OPTIONS);
}

/**
 * Valeur de `Vary` complétée par `field` (sans doublon ; `*` couvre tout).
 *
 * @param {unknown} current valeur actuelle (getHeader)
 * @param {string} field
 */
export function withVary(current, field) {
  const fields = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fields.some((entry) => entry === '*' || entry.toLowerCase() === field.toLowerCase())) return fields.join(', ');
  return [...fields, field].join(', ');
}
