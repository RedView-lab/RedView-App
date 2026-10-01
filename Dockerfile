FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm ci

COPY . .

# Commit déployé, injecté par Coolify (option « Include Source Commit in
# Build ») : lu par vite.config.ts comme identifiant de build (release Sentry,
# APP_CACHE_EPOCH). Déclaré après COPY pour ne pas invalider le cache npm ci.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}

ENV NODE_ENV=production
RUN npm run build

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

USER redview

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# node directement en PID 1 (signaux SIGTERM transmis, pas de npm intermédiaire).
CMD ["node", "--import", "tsx", "server.mjs"]
