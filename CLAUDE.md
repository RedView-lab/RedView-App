# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

RedView is a 3D route-planning / analysis app for ultra-cycling and bikepacking (React 19 + TypeScript + Vite SPA on Mapbox GL JS v3). It is French-first: root docs (`REDVIEW_*.md`, `STRUCTURE_REFACTOR_PLAN.md`), comments and commit scopes are largely in French/English mix. Commits follow conventional-commit style with a scope, e.g. `fix(chart,map): ...`.

## Commands

```bash
npm run dev          # prebuild API i18n data, then Vite dev server (also serves api/*.ts and auto-starts BRouter/POI, see below)
npm run build        # prebuild API i18n data + `tsc -b` + `vite build`  (type errors fail the build)
npm run lint         # eslint . (flat config, TS/TSX only)
npm start            # tsx server.mjs — production server: serves dist/ + api/*.ts on $PORT (default 3000)
npm run services     # / services:stop — start/stop local BRouter (17777) and POI server (17778) manually
npm run bench        # full benchmark/regression suite (bench:quick = fewer iterations)
npm run bench:pente  # single suite; others: meteo, alti, neige, brouter, fit, lidar, poi, exporter, chart, server
npm run deploy       # alias `push` — see warning below
```

There is **no unit-test framework** (no vitest/jest). "Tests" are the `script-test-bench/` benchmarks (run with `tsx`) and ad-hoc `scripts/test-*.mjs` probes against VPS services. Type-checking is `tsc -b` (use `npx tsc -b` to check without building).

`npm run deploy` runs `git add .`, commits, pushes to `origin/main`, and triggers the Coolify deploy over SSH to the production VPS. Never run it unprompted.

### Rust/WASM prediction engine

`vendor/redviewalgo/` is a Rust crate (physics-based cycling prediction, FIT/GPX parsing, KNN). Rebuild with `vendor/redviewalgo/build.ps1` (needs `wasm-pack`): it writes the JS glue + `.wasm` into `src/features/fitPredictor/engine/pkg/` and copies `redviewalgo_bg.wasm` into `public/`. Both outputs are committed; `target/` is ignored. The frontend talks to it only through a Web Worker (`fitPredictor/engine/api.ts` → `worker.ts`).

## Architecture

### Three deployable pieces
1. **Frontend SPA** (`src/`) — two Vite HTML entries: `index.html` (app) and `viewer.html` (served at `/viewer`).
2. **Node "serverless-style" API + static server** — `api/*.ts` are Vercel-style handlers (`(req, res)` with `req.query`, `req.body`, `res.status().json()`). They are executed by **two separate adapters that must stay in sync**: the `redviewDevApiPlugin` in `vite.config.ts` (dev, via `ssrLoadModule`) and `server.mjs` (prod, Docker/Coolify, `node:22-alpine`, `Dockerfile`). Both map `/api/<name>` → `api/<name>.ts`, collapse `/api/openmeteo/*` and `/api/weather/*` (server.mjs also `/api/brouter/*`) onto one file, and both re-implement the `/radar-tiles`, `/slope-tiles`, `/altitude-tiles`, `/dem-tiles` fallbacks using `server/radar-recolor.mjs` and `server/terrain-tiles.mjs`. A new API route shape or tile route usually needs changes in both places. Path normalisation, `/api` route resolution (no `_lib/`, no encoded `..`), body-size limits (`bodyLimitFor`), client-IP/rate-limit keys, tile-coordinate validation and the radar host allowlist live in the shared `server/http-security.mjs`, used by both adapters — change them there, not in each adapter. `server.mjs` also owns in-memory rate limiting, security headers and the CSP (`REDVIEW_CSP_HEADER`) — **any new external host the browser talks to (tile servers, APIs) must be added to that CSP**.
3. **VPS microservices** (Oracle VPS behind nginx, reached through the `api/` proxies via `BROUTER_UPSTREAM`, `POI_UPSTREAM`, `WEATHER_UPSTREAM` — see `.env.example`):
   - BRouter standalone (port 17777) — routing engine; `api/brouter.ts` whitelists query params and uploads dynamic BRF profiles. In dev, `scripts/start-dev-services.mjs` starts a local one if a sibling `../redview-brouter` checkout exists. The frontend generates a fresh ~500-line BRF profile from UI sliders on each change (`brf-template.ts`); see `REDVIEW_ROUTING_ARCHITECTURE.md`.
   - `server/poi-server/` — Fastify + SQLite/R*Tree POI server (port 17778), built by `server/poi-ingest/`.
   - `server/weather-daemon/` — Python GRIB ingest + tile server (systemd units, nginx conf).

### Frontend structure (`src/`)
- `App.tsx` handles bootstrap: Appwrite session, subscription gating (currently all registered users get access during open beta; non-subscribers are labelled `demo`), mobile block, then lazy-loads `pages/Dashboard`.
- `pages/Dashboard` is the composition root: it owns the Mapbox instance, active project state, and wires the feature panels together. Project persistence goes through `shared/utils/projects/*` (Appwrite rows + compression + IndexedDB cache in `shared/utils/storage`). Note: older docs mention Supabase; the live backend is **Appwrite** (`shared/services/appwrite.ts`, `node-appwrite` server-side in `api/_lib`).
- `features/*` are feature-sliced domains (`altitude`, `slope`, `snow`, `weather`, `sunlight`, `lidar`, `poi`, `fitPredictor`, `map3d`, `centerPanel`, `controlPanel`, `itineraryPanel`, `projectBrowser`, …). Convention (see `STRUCTURE_REFACTOR_PLAN.md`): `index.ts` is the public API, plus `components/ hooks/ lib/ types.ts`; import a feature through its `index.ts` where one exists. Not every feature is fully migrated to this shape. `shared/` holds cross-cutting components, hooks, i18n, services, utils. `features/freeCam` is currently a stub (feature removed, to be redeveloped).
- The central domain object is `ItineraryProject` (1..N route variants plus rider config, map viewport and per-panel settings), serialised and persisted as a whole.
- `features/map3d` wraps Mapbox (terrain, custom WebGL layers, `hooks/useMap/*`). Heavy compute lives in Web Workers / WASM (LiDAR `.las/.laz` via `copc` + `laz-perf.wasm`, FIT prediction).

### Client-side tile pipeline (Service Worker)
`public/sw-dem.js` is a thin entry that `importScripts()` modules under `public/sw-dem/{core,sources,processing,swiss,norway,spain,runtime,workers}`. It builds DEM, ortho, slope and altitude tiles in the browser from public sources (IGN, AWS Terrarium, swissALTI3D, Norway/Spain WCS); it returns 204 on real misses rather than synthesising flat tiles. Contract: the page (`features/map3d/hooks/useMap/serviceWorker.ts`) registers the SW, waits for `controllerchange`, and only then adds `/dem-tiles/` and `/ortho-tiles/` sources. **When you change anything under `public/sw-dem*`, bump the cache stamp in the header comment of `sw-dem.js`** so browsers see a byte diff and purge old caches. Analogous client cache invalidation for the app itself is `shared/lib/appCacheEpoch.ts` (`APP_CACHE_FIX_EPOCH` + build id from `VERCEL_GIT_COMMIT_SHA`/`GITHUB_SHA`).

### i18n
UI strings are **the French/English source text itself**: components call `t('Texte français ou anglais')` (`useAppI18n`) or `translateAppText(...)`; translations are `{ fr: '...', en: '...' }` pairs in `src/shared/i18n/config/translations/*.ts`. `AppI18nProvider` additionally translates DOM text nodes and `aria-label`/`placeholder`/`title` attributes through a MutationObserver, so a new user-visible string needs a pair added or it won't translate. The API layer uses `api/_lib/translations-data.ts`, which is **generated** by `scripts/prebuild-api-i18n.mjs` (regex-extracts `{ fr: '…', en: '…' }` literals from `global.ts`, `projectBrowser.ts`, `controlPanel.ts`, `dashboard.ts` only) — don't edit it by hand, and keep pairs in those files as single-object literals with quoted strings so the regex still matches.

## Build/TS conventions
- Path alias `@/*` → `src/*` (tsconfig + Vite).
- `tsconfig.app.json` is strict with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` (use `import type`), and `erasableSyntaxOnly` (no `enum`, namespaces, or constructor parameter properties).
- Env: browser-exposed vars are `VITE_*`; server-only secrets (Stripe, Appwrite API key, upstream URLs) are read from `process.env` in `api/`. `.env` is git-ignored — copy from `.env.example`.
- `.claudeignore` excludes `node_modules`, `dist`, `vendor/redviewalgo/target`, images/wasm and large geodata (`public/france-border.json`, POI icons, etc.).
