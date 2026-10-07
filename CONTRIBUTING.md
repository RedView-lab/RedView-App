# Contributing to RedView

[`CLAUDE.md`](CLAUDE.md) is the detailed reference (architecture, the rules each
subsystem relies on, every command). This page is the short version of how work
gets into `main`.

## Setup

```bash
nvm use            # Node 22 (.nvmrc), same as the production image
npm ci
cp .env.example .env
npm run dev
```

## Repository layout

| Path | Contents |
|---|---|
| `src/` | Frontend (React + TypeScript): `features/<domain>/`, cross-cutting code in `shared/`, the composition root in `pages/Dashboard/` — conventions in [`docs/architecture/structure.md`](docs/architecture/structure.md). |
| `api/` | HTTP route handlers (`api/<name>.ts` → `/api/<name>`); shared server-side code in `api/_lib/`. |
| `server/` | Shared server modules (`lib/`), real-time co-editing server (`multiplayer/`), VPS services (`poi-server/`, `poi-ingest/`, `weather-daemon/`) and host configuration (`vps/`) — see [`server/README.md`](server/README.md). Production entry point: `server.mjs`. |
| `scripts/` | Build, deploy, quality gate and operations tooling (see [`scripts/README.md`](scripts/README.md)). |
| `script-test-bench/` | Benchmarks, end-to-end journeys and regression suites on real data (see its [`README.md`](script-test-bench/README.md)). |
| `vendor/` | Rust crates compiled to WebAssembly (outputs committed). |
| `public/` | Static assets and the tile Service Worker (`sw-dem.js` + `sw-dem/`). |
| `docs/` | Architecture notes, runbooks and dated audits ([index](docs/README.md)). |

## Making a change

1. **Keep the gate green.** `npm run check` (types, lint, unit tests, knip,
   import cycles) must pass before a commit; `npm run check:full` adds the
   production build, the bundled servers and the offline regression suites — it is
   what CI and `npm run deploy` run.
2. **Tests next to the code.** `foo.ts` → `foo.test.ts` (Vitest, explicit
   `import { describe, it, expect } from 'vitest'`); server tests in
   `server/lib/__tests__/`, API tests in `api/_lib/__tests__/`.
3. **No new lint error.** Pre-existing ones are frozen in `eslint-suppressions.json`;
   fix errors rather than suppressing them, and run `npm run lint:prune` after
   fixing a frozen one.
4. **No dead code.** knip fails on unused files, exports and dependencies; madge
   fails on any runtime import cycle.
5. **User-visible strings** need a `{ fr, en }` pair in
   `src/shared/i18n/config/translations/` (`npm run i18n:audit`).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) with a scope, one
topic per commit:

```
fix(chart,map): keep the hover cursor on the route after a reroute
refactor(scripts): group operations tooling by domain
```

Several sessions may share a working tree: stage your own paths
(`git add <paths>`), never `git add .`, `git stash` or `git checkout .`.

## Deploying

`npm run deploy` deploys committed work only, after the full gate and a
production schema check. It is never run as part of a change; see `CLAUDE.md`.
