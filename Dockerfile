FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm ci

COPY . .

# Commit déployé, injecté par Coolify (option « Include Source Commit in
# Build ») : identifiant de build (server/build-id.mjs : release GlitchTip,
# tag des sourcemaps, APP_CACHE_EPOCH). Déclaré après COPY pour ne pas
# invalider le cache npm ci.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

ENV NODE_ENV=production
RUN npm run build

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
    node scripts/upload-sourcemaps.mjs dist

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 redview

# Dépendances de production uniquement (pas de vite/eslint/typescript dans l'image).
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/api ./api
# Seuls les modules runtime du serveur (pas les confs nginx/systemd ni l'ingest POI).
COPY --from=builder /app/server/*.mjs ./server/
COPY --from=builder /app/server.mjs ./server.mjs

# Release des erreurs serveur (server/build-id.mjs), même valeur que le front ;
# après npm ci pour ne pas invalider son cache à chaque commit.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

USER redview

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# node directement en PID 1 (signaux SIGTERM transmis, pas de npm intermédiaire).
CMD ["node", "--import", "tsx", "server.mjs"]
