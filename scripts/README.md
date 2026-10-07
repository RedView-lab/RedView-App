# scripts/

Tooling run from a developer machine or the build — never imported by the app.
Every entry point is runnable from the repository root; most are wired to an
`npm run` command (see `package.json`). Scripts that talk to production read
their credentials from `.env` (never committed).

| Folder | Contents | Main commands |
|---|---|---|
| [`build/`](build) | Build steps: API i18n data, bundled servers (esbuild), static precompression, sourcemap upload to GlitchTip | `npm run build`, `npm run build:server` (also run by the `Dockerfile`s) |
| [`quality/`](quality) | The quality gate and its checks: initial-load bundle budget, bundled servers started for real, i18n coverage | `npm run check`, `npm run check:full`, `npm run bundle:check`, `npm run server:check`, `npm run i18n:audit` |
| [`release/`](release) | Deploy to production (gate + schema check + push + Coolify) and rollback to a kept image | `npm run deploy`, `npm run rollback` — never run unprompted |
| [`dev/`](dev) | Local BRouter / POI / real-time servers and the SSH tunnel to the VPS (started by `npm run dev`) | `npm run services`, `npm run services:stop` |
| [`appwrite/`](appwrite) | Production database operations: schema (`--check` in deploy), permission audits and migrations, shared-project security audit, interrupted account deletions, co-editing test accounts | `node --env-file=.env scripts/appwrite/setup-appwrite-schema.mjs --check` |
| [`analytics/`](analytics) | Activation report from the database, internal-account labels, Umami boards / funnels as code (`umami/`) | `npm run analytics:report`, `npm run analytics:sync` |
| [`billing/`](billing) | Stripe products (billing is frozen) | — |
| [`vps/`](vps) | Host hardening and read-only performance snapshots of the VPS, e-mail DNS check | `bash scripts/vps/perf-snapshot.sh <label>` |
| [`routing/`](routing) | BRouter scenario runner and routing probes (foot profiles, gravel, GT20) | `npx tsx scripts/routing/run-scenarios.ts` |
| [`probes/`](probes) | One-off diagnostics against live services (Open-Meteo, POI, weather, swisstopo, IGN WMS) kept for their method | `npm run test:openmeteo:vps` |
| [`lidar-index/`](lidar-index) | Regenerates the LiDAR file indexes and coverage polygons (JP, NZ, NL, BE, FR, CH) | `npm run lidar:index` |
| [`design-workbench/`](design-workbench) | Self-contained HTML copy of the dashboard for the designer, with an edit export | `npm run workbench`, `npm run workbench:verify` |

Benchmarks, end-to-end journeys and regression suites live in
[`script-test-bench/`](../script-test-bench), not here.
