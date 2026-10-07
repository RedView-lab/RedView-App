// Identifiant de build, unique source pour : la release GlitchTip du front
// (define __REDVIEW_BUILD_ID__ de vite.config.ts) et du serveur, le tag des
// sourcemaps uploadées (scripts/build/upload-sourcemaps.mjs) et APP_CACHE_EPOCH.
//
// En prod Docker / Coolify, SOURCE_COMMIT est passé en ARG de build et en ENV
// du stage runner (voir Dockerfile) ; sans lui, npm_package_version (« 0.0.0 »)
// ne change jamais d'un déploiement à l'autre.
//
// Module sans effet de bord : bundlé dans dist-server/ (scripts/build/build-server.mjs),
// un test « lancé en script » via import.meta.url y serait vrai au démarrage du serveur.

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
