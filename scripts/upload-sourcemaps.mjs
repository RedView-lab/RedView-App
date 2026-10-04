/**
 * Sourcemaps du build → GlitchTip, puis suppression des `.map` de dist/.
 *
 * Lancé par le Dockerfile (stage builder) après `npm run build` :
 *   node scripts/upload-sourcemaps.mjs [dist]
 *
 * GlitchTip n'implémente pas l'upload par morceaux de sentry-cli : on passe par
 * glitchtip-cli (binaire statique, SHA-256 épinglé). Chaque bundle reçoit un
 * debug ID (`sourcemaps inject`) qui relie une erreur à sa map quelle que soit
 * l'URL ; la release est l'identifiant de build (server/build-id.mjs), la même
 * que celle du SDK (src/main.tsx).
 *
 * Configuration (build Coolify) :
 *   SENTRY_AUTH_TOKEN   secret de build (/run/secrets/SENTRY_AUTH_TOKEN) ou variable
 *   SENTRY_URL          https://errors.redview.tech
 *   SENTRY_ORG, SENTRY_PROJECT
 *   GLITCHTIP_CLI       binaire local (vérification hors Docker), sinon téléchargé
 *
 * Un upload impossible n'échoue PAS le build (débogage moins confortable, pas
 * une panne) mais s'affiche clairement. Les `.map` sont supprimées dans tous
 * les cas : elles ne doivent jamais être servies.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBuildId } from '../server/build-id.mjs';

const CLI_VERSION = 'v1.0.0';
const CLI_BINARIES = {
  x64: { asset: 'glitchtip-cli-linux-x86_64', sha256: 'de1c035aa61931a6265d7b29b1614781dfee925466142a907508cb097082dfef' },
  arm64: { asset: 'glitchtip-cli-linux-arm64', sha256: '781b8ba3fefe10d1586fb03438f7f6cbfdceccdb70b7fac0ee23342476d9af3a' },
};
const SECRET_FILE = '/run/secrets/SENTRY_AUTH_TOKEN';

const distDir = path.resolve(process.argv[2] ?? 'dist');
// Bundles Vite seulement : les scripts de public/ (Service Worker) n'ont pas
// de map et ne doivent pas être modifiés par l'injection.
const assetsDir = path.join(distDir, 'assets');

const log = (message) => console.log(`[sourcemaps] ${message}`);

function readToken() {
  try {
    const secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (secret) return secret;
  } catch {
    // Pas de secret de build : variable d'environnement.
  }
  return process.env.SENTRY_AUTH_TOKEN?.trim() ?? '';
}

function listMaps(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.map'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function removeMaps() {
  const maps = listMaps(distDir);
  for (const file of maps) fs.rmSync(file);
  log(`${maps.length} fichier(s) .map supprimé(s) de ${path.relative(process.cwd(), distDir) || '.'}`);
}

async function downloadCli() {
  const binary = process.platform === 'linux' ? CLI_BINARIES[process.arch] : undefined;
  if (!binary) throw new Error(`pas de binaire glitchtip-cli pour ${process.platform}/${process.arch}`);
  const job = `build-${binary.asset.slice('glitchtip-cli-'.length)}`;
  const url = `https://gitlab.com/glitchtip/glitchtip-cli/-/jobs/artifacts/${CLI_VERSION}/raw/artifacts/${binary.asset}?job=${job}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`téléchargement de glitchtip-cli : HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== binary.sha256) throw new Error(`SHA-256 de glitchtip-cli inattendu (${digest})`);
  const file = path.join(os.tmpdir(), `glitchtip-cli-${process.pid}`);
  fs.writeFileSync(file, bytes, { mode: 0o755 });
  return { file, temporary: true };
}

function runCli(cli, args, token) {
  const result = spawnSync(cli, args, {
    stdio: 'inherit',
    env: { ...process.env, SENTRY_AUTH_TOKEN: token },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`glitchtip-cli ${args.slice(0, 2).join(' ')} : code ${result.status}`);
}

async function upload(token) {
  const local = process.env.GLITCHTIP_CLI;
  const cli = local ? { file: local, temporary: false } : await downloadCli();
  try {
    const release = resolveBuildId();
    runCli(cli.file, ['sourcemaps', 'inject', assetsDir], token);
    runCli(cli.file, [
      'sourcemaps', 'upload', assetsDir,
      '--release', release,
      '--project', process.env.SENTRY_PROJECT,
      '--url-prefix', '~/assets',
      '--validate',
    ], token);
    log(`maps uploadées pour la release ${release}`);
  } finally {
    if (cli.temporary) fs.rmSync(cli.file, { force: true });
  }
}

async function main() {
  if (!fs.existsSync(assetsDir)) {
    log(`${assetsDir} absent : rien à faire`);
    return;
  }
  const token = readToken();
  const missing = ['SENTRY_URL', 'SENTRY_ORG', 'SENTRY_PROJECT'].filter((name) => !process.env[name]);
  if (!token) missing.unshift('SENTRY_AUTH_TOKEN');
  if (missing.length > 0) {
    log(`upload ignoré : ${missing.join(', ')} absent(s)`);
  } else {
    try {
      await upload(token);
    } catch (error) {
      log(`AVERTISSEMENT : sourcemaps NON uploadées (${error instanceof Error ? error.message : error}) ; les erreurs du front resteront minifiées pour ce build`);
    }
  }
  removeMaps();
}

await main();
