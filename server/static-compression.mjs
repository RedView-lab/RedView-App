// ---------------------------------------------------------------------------
// Statiques compressibles : une seule règle pour la précompression du build
// (scripts/precompress-dist.mjs, dans l'image) et pour le serveur qui sert les
// variantes (server.mjs).
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
