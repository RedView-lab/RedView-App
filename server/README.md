# server/

Server-side code outside the HTTP route handlers (`api/`). The production
entry point of the app server is [`../server.mjs`](../server.mjs); in
development the same handlers run inside Vite (`redviewDevApiPlugin` in
`vite.config.ts`). Both adapters share the modules of `lib/`.

| Folder | What it is | Runs where |
|---|---|---|
| [`lib/`](lib) | Modules shared by the production adapter, the dev adapter, the API handlers and the real-time server: request hardening (`http-security.mjs`), CSP, compression, request decoding, logging, error reporting, build id, project access rights, byte-bounded caches, tile fallbacks. Tests in `lib/__tests__/`. | Bundled into `dist-server/` (app image) and `dist-server/multiplayer.mjs` |
| [`multiplayer/`](multiplayer) | Real-time co-editing server (WebSocket, journal, checkpoints, shadow validation); the engine itself is `src/features/collab`. | Own Coolify service (`Dockerfile.multiplayer`) |
| [`poi-server/`](poi-server) | POI service (Fastify + SQLite R*Tree), its own `package.json`. | VPS, behind nginx, reached through `api/poi.ts` |
| [`poi-ingest/`](poi-ingest) | Builds the POI database (OSM, relations, Overture, ATP, SIRENE) and swaps it in. | VPS / workstation, offline |
| [`weather-daemon/`](weather-daemon) | GRIB ingest and weather tile server (Python, systemd units, nginx conf). | VPS |
| [`vps/`](vps) | Versioned host configuration: systemd units and drop-ins, nginx, sysctl, journald, Docker, Appwrite override, Open-Meteo, Umami, service watch, backups. See its [README](vps/README.md). | VPS host |

Rules that apply to every module here (details in `CLAUDE.md`): every
in-memory cache is bounded in bytes (`lib/byte-lru.mjs`); request-shape and
security rules live once in `lib/http-security.mjs`, never in each adapter;
rights on projects come from `lib/project-access.mjs`, never from client-written
attributes.
