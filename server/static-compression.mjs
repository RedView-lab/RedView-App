// ---------------------------------------------------------------------------
// Statiques compressibles : une seule règle pour la précompression du build
// (scripts/precompress-dist.mjs, dans l'image) et pour le serveur qui sert les
// variantes (server.mjs). La négociation `Accept-Encoding` sert aussi aux
// réponses API (server/api-compression.mjs).
// ---------------------------------------------------------------------------

const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm', '.txt', '.brf']);
const MIN_COMPRESS_BYTES = 1024;
// Au-delà, le fichier est diffusé brut en flux plutôt que bufferisé.
const MAX_COMPRESS_BYTES = 32 * 1024 * 1024;

/** Suffixe de la variante précompressée par encodage HTTP. */
export const VARIANT_SUFFIX = { br: '.br', gzip: '.gz' };

/**
 * @param {string} ext extension en minuscules, point compris
 * @param {number} size taille en octets
 */
export function isCompressible(ext, size) {
  return COMPRESSIBLE_EXTENSIONS.has(ext) && size >= MIN_COMPRESS_BYTES && size <= MAX_COMPRESS_BYTES;
}

/**
 * Encodages acceptés d'après Accept-Encoding (q-values respectées, `*`
 * compris), du préféré au moins préféré : brotli d'abord à poids égal.
 * Liste vide : identité seulement.
 *
 * @param {string | string[] | undefined} acceptEncoding
 * @returns {Array<'br' | 'gzip'>}
 */
export function acceptedEncodings(acceptEncoding) {
  if (!acceptEncoding) return [];
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
  /** @type {Array<'br' | 'gzip'>} */
  const ordered = br > 0 && br >= gzip ? ['br', 'gzip'] : ['gzip', 'br'];
  return ordered.filter((encoding) => (encoding === 'br' ? br : gzip) > 0);
}
