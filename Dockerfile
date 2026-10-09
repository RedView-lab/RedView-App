# Image de base épinglée par le digest de son index multi-architecture (le VPS
# est ARM64) : un build rejoue exactement la même image. Dependabot (écosystème
# docker) propose les nouveaux digests ; les deux Dockerfile gardent le même.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
# Cache npm BuildKit : réutilisé d'un build à l'autre, jamais dans une couche de l'image.
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .

# Commit déployé, injecté par Coolify (option « Include Source Commit in
# Build ») : identifiant de build (server/lib/build-id.mjs : release GlitchTip,
# tag des sourcemaps, APP_CACHE_EPOCH). Déclaré après COPY pour ne pas
# invalider le cache npm ci.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

ENV NODE_ENV=production
# Front (dist/) puis serveur bundlé (dist-server/ : server.mjs et les routes
# api/ en .mjs, sans tsx à l'exécution — scripts/build/build-server.mjs).
RUN npm run build && node scripts/build/build-server.mjs --app

# Sourcemaps → GlitchTip (release = identifiant de build), puis suppression des
# .map de dist/ : jamais dans l'image. Sans configuration, l'upload est ignoré
# et les maps supprimées quand même. Token : secret de build de préférence
# (Coolify « Use Docker Build Secrets ») ; l'ARG est un repli qui ne quitte pas
# ce stage (le runner ne reçoit que dist/).
ARG SENTRY_URL=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG SENTRY_AUTH_TOKEN=""
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN \
    node scripts/build/upload-sourcemaps.mjs dist

# Variantes .br/.gz des statiques, servies par négociation : la prod ne
# compresse rien à l'exécution (ni CPU, ni cache mémoire).
RUN node scripts/build/precompress-dist.mjs dist

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 redview

# Dépendances d'exécution du serveur uniquement (`dependencies` de package.json :
# Appwrite, Stripe, pino, Sentry…) ; tout le front est dans dist/.
COPY --from=builder /app/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# @mattnucc/gribberish (GRIB2 de Météo-France, api/meteofrance.ts) n'a aucun
# binaire Linux ARM64 : sur le VPS (Oracle A1, aarch64 musl), il se replie sur
# sa version WebAssembly (même décodeur Rust), que npm n'installe jamais
# d'office (`cpu: wasm32`). Installée à part, à la version du paquet principal,
# puis copiée paquet par paquet sans rien écraser (`cp -rn` de BusyBox saute un
# dossier de portée déjà présent, @mattnucc, au lieu de le fusionner). Vérifié
# le 2026-10-09 dans node:22-alpine sur le VPS : repli automatique, GRIB2
# décodé à l'identique du binaire natif.
RUN --mount=type=cache,target=/root/.npm \
    GRIB_VERSION="$(node -p "require('./node_modules/@mattnucc/gribberish/package.json').version")" \
  && npm install --prefix /tmp/grib-wasi --no-save --no-package-lock --force --ignore-scripts \
       "@mattnucc/gribberish-wasm32-wasi@${GRIB_VERSION}" \
  && cd /tmp/grib-wasi/node_modules \
  && for pkg in */ @*/*/; do \
       [ -e "/app/node_modules/$pkg" ] || { mkdir -p "/app/node_modules/$(dirname "$pkg")" && cp -r "$pkg" "/app/node_modules/$pkg"; }; \
     done \
  && cd /app \
  && rm -rf /tmp/grib-wasi

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

# Chaque route se charge sur la plateforme de l'image : un module natif sans
# binaire pour elle fait échouer le build (l'ancienne image reste en ligne)
# au lieu de répondre 500 en production.
COPY --from=builder /app/scripts/build/check-route-imports.mjs ./scripts/build/check-route-imports.mjs
RUN node scripts/build/check-route-imports.mjs dist-server/api

# Release des erreurs serveur (server/lib/build-id.mjs), même valeur que le front ;
# après npm ci pour ne pas invalider son cache à chaque commit.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

USER redview

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# node directement en PID 1 (signaux SIGTERM transmis, pas de npm intermédiaire).
CMD ["node", "dist-server/server.mjs"]
