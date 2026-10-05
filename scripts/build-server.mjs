/**
 * Bundles du serveur de prod (esbuild) → dist-server/, lancés par `node` sans tsx :
 *   node scripts/build-server.mjs                  app + temps réel
 *   node scripts/build-server.mjs --app            server.mjs et les routes api/
 *   node scripts/build-server.mjs --multiplayer    serveur de co-édition
 *
 * - app : dist-server/server.mjs et une entrée par route (dist-server/api/<route>.mjs,
 *   même règle de nom que resolveApiRoute), code partagé dans dist-server/chunks/.
 *   `process.env.REDVIEW_SERVER_BUNDLE` vaut "1" à la compilation : server.mjs
 *   en déduit la racine (dist/ à côté de dist-server/) et l'extension des routes.
 * - temps réel : dist-server/multiplayer.mjs (server/multiplayer/main.ts et le
 *   moteur de co-édition de src/, alias `@/` de tsconfig.multiplayer.json).
 *
 * Les dépendances d'exécution (`dependencies` de package.json, seules
 * installées dans les images) restent externes ; tout le reste est bundlé, et
 * un paquet de `devDependencies` qui finirait dans un bundle fait échouer le
 * build (il manquerait dans l'image). Non minifié : piles d'erreurs lisibles
 * dans GlitchTip.
 */
import fs from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

import { listApiRoutes } from '../server/http-security.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-server');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const runtimeDependencies = Object.keys(pkg.dependencies ?? {});

const args = new Set(process.argv.slice(2));
const buildApp = args.has('--app') || !args.has('--multiplayer');
const buildMultiplayer = args.has('--multiplayer') || !args.has('--app');

const log = (message) => console.log(`[build-server] ${message}`);

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: ROOT,
  outdir: OUT_DIR,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  external: runtimeDependencies.flatMap((name) => [name, `${name}/*`]),
  minify: false,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
};

/** Paquets npm bundlés (hors dépendances d'exécution, externes) : il ne doit y en avoir aucun. */
function bundledPackages(metafile) {
  const packages = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input.replaceAll('\\', '/'));
    if (match) packages.add(match[1]);
  }
  return [...packages].sort();
}

function report(label, metafile) {
  const outputs = Object.entries(metafile.outputs).filter(([file]) => !file.endsWith('.map'));
  const bytes = outputs.reduce((sum, [, output]) => sum + output.bytes, 0);
  log(`${label} : ${outputs.length} fichier(s), ${(bytes / 1024).toFixed(0)} Ko`);
  const packages = bundledPackages(metafile);
  if (packages.length > 0) {
    throw new Error(`${label} : paquets npm bundlés hors dependencies (absents de l'image) : ${packages.join(', ')}`);
  }
}

async function buildAppServer() {
  for (const target of ['server.mjs', 'api', 'chunks']) {
    fs.rmSync(path.join(OUT_DIR, target), { recursive: true, force: true });
  }
  const entryPoints = { server: 'server.mjs' };
  for (const route of listApiRoutes(path.join(ROOT, 'api'), '.ts')) {
    entryPoints[`api/${route}`] = `api/${route}.ts`;
  }
  const result = await build({
    ...common,
    entryPoints,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    tsconfig: 'tsconfig.api.json',
    define: { 'process.env.REDVIEW_SERVER_BUNDLE': '"1"' },
  });
  report(`app (${Object.keys(entryPoints).length - 1} routes)`, result.metafile);
}

async function buildMultiplayerServer() {
  fs.rmSync(path.join(OUT_DIR, 'multiplayer.mjs'), { force: true });
  const result = await build({
    ...common,
    entryPoints: { multiplayer: 'server/multiplayer/main.ts' },
    tsconfig: 'tsconfig.multiplayer.json',
  });
  report('temps réel', result.metafile);
}

try {
  if (buildApp) await buildAppServer();
  if (buildMultiplayer) await buildMultiplayerServer();
} catch (error) {
  console.error(`[build-server] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
