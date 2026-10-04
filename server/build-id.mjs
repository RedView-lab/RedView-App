// Identifiant de build, unique source pour : la release GlitchTip du front
// (define __REDVIEW_BUILD_ID__ de vite.config.ts) et du serveur, le tag des
// sourcemaps uploadées (scripts/upload-sourcemaps.mjs) et APP_CACHE_EPOCH.
//
// En prod Docker / Coolify, SOURCE_COMMIT est passé en ARG de build et en ENV
// du stage runner (voir Dockerfile) ; sans lui, npm_package_version (« 0.0.0 »)
// ne change jamais d'un déploiement à l'autre.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {Record<string, string | undefined>} [env] */
export function resolveBuildId(env = process.env) {
  return (
    env.VERCEL_GIT_COMMIT_SHA
    || env.GITHUB_SHA
    || env.SOURCE_COMMIT
    || env.npm_package_version
    || 'dev'
  ).slice(0, 12);
}

// `node server/build-id.mjs` imprime l'identifiant (script d'upload des sourcemaps).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.stdout.write(resolveBuildId());
