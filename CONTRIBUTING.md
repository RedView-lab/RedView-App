# Contributing to RedView

[← Repository](README.md) · [Docs index](docs/README.md) · [Security](SECURITY.md)

This page is the short path from a fresh clone to a change merged in `main`.
[`CLAUDE.md`](CLAUDE.md) is the detailed reference: the architecture, the rules
each subsystem relies on, and every command.

## 1. Set up

```bash
nvm use               # Node 22 (.nvmrc), the version of the production image
npm ci
cp .env.example .env  # Appwrite, Mapbox and upstream values
npm run dev
```

## 2. Find where the code goes

| Path | Contents |
|---|---|
| [`src/`](src) | Frontend (React + TypeScript): one folder per domain in `features/`, cross-cutting code in `shared/`, the composition root in `pages/Dashboard/`. Conventions: [`docs/architecture/structure.md`](docs/architecture/structure.md). |
| [`api/`](api) | HTTP route handlers (`api/<name>.ts` → `/api/<name>`); shared server-side code in `api/_lib/`. |
| [`server/`](server/README.md) | Shared server modules (`lib/`), real-time co-editing server (`multiplayer/`), VPS services and host configuration. Production entry point: [`server.mjs`](server.mjs). |
| [`public/`](public) | Static assets and the tile Service Worker (`sw-dem.js` + `sw-dem/`). |
| [`vendor/`](vendor) | Rust crates compiled to WebAssembly; their outputs are committed. |
| [`scripts/`](scripts/README.md) | Build, quality gate, release and operations tooling. |
| [`script-test-bench/`](script-test-bench/README.md) | Benchmarks, end-to-end journeys and regression suites on real data. |
| [`test/`](test) | Tests of code that cannot host its own (the Service Worker in `public/`). |
| [`docs/`](docs/README.md) | Architecture notes, runbooks and dated audits. |

## 3. Make the change

- **Tests sit next to the code.** `foo.ts` → `foo.test.ts`, with an explicit
  `import { describe, it, expect } from 'vitest'`. Server tests go in
  `server/lib/__tests__/`, API tests in `api/_lib/__tests__/`. Cover business
  rules, security boundaries, persistence and routing math first.
- **Every user-visible string is translated.** Add a `{ fr, en }` pair in
  `src/shared/i18n/config/translations/`, then check with `npm run i18n:audit`.
- **New external host?** Add it to the Content-Security-Policy in
  [`server/lib/csp.mjs`](server/lib/csp.mjs), or the browser will block it.
- **Changed anything under `public/sw-dem*`?** Add a dated line to the cache stamp
  in the header of `public/sw-dem.js`.

## 4. Check it

| Command | When |
|---|---|
| `npm run check` | Before every commit: types, ESLint, unit tests, knip, import cycles (about a minute cold, much less warm) |
| `npm run check:full` | Before a pull request: adds the production build, the bundle budget, the bundled servers started for real, the end-to-end journey and the regression suites. CI runs the same. |
| `npm run bench:<suite>` | When a change touches a measured area: see [`script-test-bench/`](script-test-bench/README.md) |

The gate is strict on purpose:

- **ESLint ratchet.** Pre-existing errors are frozen in `eslint-suppressions.json`
  and no new error can be added. Fix errors rather than suppressing them; after
  fixing a frozen one, run `npm run lint:prune`.
- **No dead code.** knip fails on an unused file, dependency or export; delete
  what a change leaves unused.
- **No import cycle.** madge fails on any runtime cycle in `src/`.

## 5. Commit

[Conventional Commits](https://www.conventionalcommits.org/), with a scope and
one topic per commit:

```text
fix(chart,map): keep the hover cursor on the route after a reroute
refactor(scripts): group operations tooling by domain
docs(readme): link the folder maps
```

Several sessions can share one working tree. Stage and commit only your own
paths (`git commit -- <paths>`); never `git add .`, `git stash` or
`git checkout .`.

## 6. Ship

Open a pull request against `main` using the template, and wait for CI.
Deployment is a separate, deliberate step: `npm run deploy` deploys committed
work only, after the full gate and a production schema check. See `CLAUDE.md`
before running it, and never run it as part of a change.
