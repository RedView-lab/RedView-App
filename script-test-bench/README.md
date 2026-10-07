# script-test-bench/

Benchmarks, end-to-end journeys and regression suites that are too heavy, too
slow or too data-hungry for the Vitest unit tests (those live next to the code,
`foo.ts` → `foo.test.ts`). Everything runs from the repository root through an
`npm run` command; type-checked by `npm run typecheck:bench` (`tsconfig.bench.json`).

## Layout

| Folder | What it checks | Commands |
|---|---|---|
| `run-all-benchmarks.ts`, [`core/`](core), [`suites/`](suites) | Performance suites per domain (weather, slopes, altitude, snow, BRouter profiles, pace engine, LiDAR, POI, exporters, chart series, server, flyover) with thresholds; each run is compared with the previous report and the machine state | `npm run bench` (`bench:quick`), `npm run bench:<suite>` |
| [`regression/`](regression) | Offline correctness regressions on real code paths: `.redview` files, project layers, co-editing simulator, POI auto-sort, route elevation | `npm run bench:redview`, `bench:project-layers`, `bench:collab`, `bench:poi-autosort` (the first three run in `check:full`) |
| [`flyover/`](flyover), [`follow/`](follow) | 3D route playback camera, live-presence follow playout (pure) and frame-by-frame replay in a virtual browser | `npm run bench:flyover`, `bench:follow`, `bench:follow-frames` |
| [`avalanche/`](avalanche), [`lidar-lod/`](lidar-lod), [`snow-quality/`](snow-quality) | LiDAR viewer analyses and level of detail, snow depth engine against physics checks and the frozen v1 engine | `npm run bench:avalanche`, `bench:lidar-lod`, `bench:snow` |
| [`pace-accuracy/`](pace-accuracy) | Moving-time engine against real FIT rides, synthetic physics scenarios and public references | `npm run bench:pace`, `bench:pace:prep`, `bench:pace:realism` |
| [`routing-quality/`](routing-quality), [`route-continuity/`](route-continuity) | ~660 routing scenarios against production BRouter; no straight line in stored routes | `npm run bench:routing` (+ `:sweep`, `:compare`, `:report`) |
| [`collab-load/`](collab-load), [`collab-e2e/`](collab-e2e) | Real-time server under load and across restarts; two-user journeys in a real browser (dev server or production test accounts) | `npm run bench:collab-load`, `bench:collab-e2e`, `bench:collab-prod` |
| [`user-journey/`](user-journey), [`dashboard-perf/`](dashboard-perf), [`screen-audit/`](screen-audit) | Production build in a headless browser against an in-memory Appwrite: main user journey, load / smoothness / leaks on throttled networks, layout on 15 screen sizes | `npm run e2e:journey`, `bench:dashboard`, `bench:screens` |
| [`lidar-viewer-engines/`](lidar-viewer-engines), [`lidar-viewer-perf/`](lidar-viewer-perf), [`lidar-viewer-shots/`](lidar-viewer-shots) | LiDAR viewer on WebGPU and WebGL 2 in Chromium / Firefox / WebKit, frame rate and fixed-view captures | `npm run bench:lidar-engines`, `bench:lidar-fps`, `bench:lidar-shots` |
| [`audit/`](audit) | Reproduction scripts of dated audits (each exits non-zero while its bug reproduces) — see [`docs/audits/`](../docs/audits) | `npx tsx script-test-bench/audit/<file>` |
| [`poi-external/`](poi-external) | Data study for completing the POI base from external sources (Overture, ATP, SIRENE) | see `docs/audits/REDVIEW_POI_EXTERNAL_SOURCES.md` |
| `reports/` | Outputs; JSON and run artefacts are git-ignored, only the curated Markdown reports are kept | — |

`CLAUDE.md` describes what each suite measures, its thresholds and its latest
reference numbers.

## Conventions

- A suite fails with a non-zero exit code on a regression; a threshold is
  re-measured once before it counts.
- Suites in `suites/` export a `run…Benchmark()` function used by
  `run-all-benchmarks.ts` and can also be run alone (`npm run bench:<suite>`).
- Benchmarks that need production data or credentials (real FIT files, test
  accounts, an SSH tunnel) read them from outside the repository and say so in
  their header.
- Timings taken on a laptop on battery are noise: compare interleaved A/B runs.
