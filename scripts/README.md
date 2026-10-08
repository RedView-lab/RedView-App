# scripts/

[← Repository](../README.md) · [Docs index](../docs/README.md)

Tooling that runs on a developer machine or during the build. The app never
imports it. Run every script from the repository root; most of them are wired
to an `npm run` command in [`package.json`](../package.json). Scripts that talk
to production read their credentials from `.env`, which is never committed
(start from [`.env.example`](../.env.example)).

> Benchmarks, end-to-end journeys and regression suites are in
> [`script-test-bench/`](../script-test-bench/README.md), not here.

## The commands you will use most

```bash
npm run dev          # API i18n data, then Vite + local services + SSH tunnel to the VPS
npm run check        # quality gate: types, lint, unit tests, knip, import cycles
npm run check:full   # + production build, bundled servers, offline regressions (CI and deploy run this)
npm run build        # production build (type errors fail it)
```

`npm run deploy` and `npm run rollback` act on production. They are only run
on purpose, never as part of a change (see [Release](#release)).

## Folders

| Folder | What it contains | Main commands |
|---|---|---|
| [`build/`](build) | Build steps: API i18n data, bundled servers (esbuild), static precompression, sourcemap upload to GlitchTip | `npm run build`, `npm run build:server` (the `Dockerfile`s run them too) |
| [`quality/`](quality) | The quality gate and its checks: initial-load bundle budget, bundled servers started for real, i18n coverage | `npm run check`, `npm run check:full`, `npm run bundle:check`, `npm run server:check`, `npm run i18n:audit` |
| [`release/`](release) | Deploy to production (gate + schema check + push + Coolify) and roll back to a kept image | `npm run deploy`, `npm run rollback` |
| [`dev/`](dev) | Local BRouter, POI and real-time servers, and the SSH tunnel to the VPS (`npm run dev` starts them) | `npm run services`, `npm run services:stop` |
| [`appwrite/`](appwrite) | Production database operations: schema (checked by deploy), permission audits and migrations, shared-project security audit, interrupted account deletions, co-editing test accounts | `node --env-file=.env scripts/appwrite/setup-appwrite-schema.mjs --check` |
| [`analytics/`](analytics) | Activation report from the database, internal-account labels, Umami boards and funnels as code (`umami/`) | `npm run analytics:report`, `npm run analytics:sync` |
| [`billing/`](billing) | Stripe products. Billing is frozen. | — |
| [`vps/`](vps) | VPS hardening, read-only performance snapshots, e-mail DNS check | `bash scripts/vps/perf-snapshot.sh <label>` |
| [`routing/`](routing) | BRouter scenario runner and routing probes (foot profiles, gravel, GT20) | `npx tsx scripts/routing/run-scenarios.ts` |
| [`probes/`](probes) | One-off diagnostics against live services (Open-Meteo, POI, weather, swisstopo, IGN WMS), kept for their method | `npm run test:openmeteo:vps` |
| [`lidar-index/`](lidar-index) | Regenerates the LiDAR file indexes and coverage polygons (JP, NZ, NL, BE, FR, CH) | `npm run lidar:index` |
| [`design-workbench/`](design-workbench) | Self-contained HTML copy of the dashboard for the designer, with an export of the edits | `npm run workbench`, `npm run workbench:verify` |

## Release

`npm run deploy` deploys **committed work only**. It stops on a dirty working
tree. It then runs `check:full`, compares the production Appwrite schema with
`appwrite/setup-appwrite-schema.mjs`, pushes to `main` and triggers the Coolify
deploy. If any step fails, nothing is pushed.

`npm run rollback` lists the images Coolify keeps for each commit.
`npm run rollback -- <sha>` restarts one of them. It rolls back code only,
never the schema or the data.

The full procedure is in [`CLAUDE.md`](../CLAUDE.md).

## Adding a script

- Put it in the folder of its role. Name it after what it does
  (`probes/` scripts are diagnostics, not tests run by the gate).
- If it is meant to be run again, wire it to an `npm run` command.
- Read secrets from `.env` or from a file outside the repository, never from
  the command line or the code.
