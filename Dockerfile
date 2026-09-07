FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package*.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 redview

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/api ./api
COPY --from=builder /app/server.mjs ./server.mjs

USER redview

EXPOSE 3000

CMD ["npm", "run", "start"]
