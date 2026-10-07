/**
 * Précompression des statiques du build : `<fichier>.br` et `<fichier>.gz`
 * à côté de chaque fichier compressible de dist/ (server/static-compression.mjs).
 *
 * Lancé par le Dockerfile (stage builder) après l'upload des sourcemaps :
 *   node scripts/build/precompress-dist.mjs [dist]
 *
 * server.mjs sert ces variantes par négociation (Accept-Encoding) : la prod ne
 * compresse plus rien à l'exécution, ni CPU au premier visiteur d'un
 * déploiement, ni cache mémoire. Brotli au niveau maximal (11, fenêtre 16 Mo)
 * jusqu'à 4 Mo, 9 au-delà ; gzip 9. Une variante qui gagne moins de 10 %
 * n'est pas écrite : le fichier est alors servi tel quel. Une variante déjà
 * plus récente que son fichier est gardée (relance rapide en local).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { VARIANT_SUFFIX, isCompressible } from '../../server/static-compression.mjs';

const brotliCompressAsync = promisify(zlib.brotliCompress);
const gzipAsync = promisify(zlib.gzip);

const BROTLI_MAX_QUALITY_MAX_BYTES = 4 * 1024 * 1024;
const MIN_GAIN = 0.1;

const distDir = path.resolve(process.argv[2] ?? 'dist');
const log = (message) => console.log(`[precompress] ${message}`);

const ENCODERS = {
  br: (raw) => brotliCompressAsync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > BROTLI_MAX_QUALITY_MAX_BYTES ? 9 : 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  }),
  gzip: (raw) => gzipAsync(raw, { level: 9 }),
};

function listCandidates(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => isCompressible(path.extname(file).toLowerCase(), fs.statSync(file).size));
}

const totals = { files: 0, raw: 0, br: 0, gzip: 0, written: 0, kept: 0 };

/** Écrit (ou garde) les variantes d'un fichier ; ajoute au total ce que le client téléchargera. */
async function precompress(file) {
  const raw = await fs.promises.readFile(file);
  const { mtimeMs } = await fs.promises.stat(file);
  totals.files += 1;
  totals.raw += raw.length;
  for (const [encoding, encode] of Object.entries(ENCODERS)) {
    const variantFile = file + VARIANT_SUFFIX[encoding];
    const existing = await fs.promises.stat(variantFile).catch(() => null);
    if (existing && existing.mtimeMs >= mtimeMs) {
      totals[encoding] += existing.size;
      totals.kept += 1;
      continue;
    }
    const packed = await encode(raw);
    if (packed.length > raw.length * (1 - MIN_GAIN)) {
      await fs.promises.rm(variantFile, { force: true });
      totals[encoding] += raw.length;
      continue;
    }
    await fs.promises.writeFile(variantFile, packed);
    totals[encoding] += packed.length;
    totals.written += 1;
  }
}

async function main() {
  if (!fs.existsSync(distDir)) {
    console.error(`[precompress] dossier absent : ${distDir}`);
    process.exit(1);
  }
  const started = Date.now();
  const queue = listCandidates(distDir);
  // zlib asynchrone tourne dans le pool libuv : quelques tâches en vol suffisent à l'occuper.
  const workers = Array.from({ length: Math.max(2, os.availableParallelism()) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) await precompress(file);
  });
  await Promise.all(workers);
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} Mo`;
  log(`${totals.files} fichiers, ${mb(totals.raw)} → brotli ${mb(totals.br)}, gzip ${mb(totals.gzip)} `
    + `(${totals.written} variantes écrites, ${totals.kept} gardées) en ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

await main();
