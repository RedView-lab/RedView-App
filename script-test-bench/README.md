# script-test-bench/

[← Repository](../README.md) · [Docs index](../docs/README.md)

Benchmarks, end-to-end journeys and regression suites that are too heavy, too
slow or too data-hungry for the unit tests. The unit tests are Vitest files
next to the code (`foo.ts` → `foo.test.ts`). Every suite runs from the
repository root through an `npm run` command, and `npm run typecheck:bench`
type-checks all of them (`tsconfig.bench.json`).

## Start here

```bash
npm run check:full     # the gate also runs the production user journey and four offline regressions
npm run bench:quick    # every performance suite, fewer iterations
npm run bench:<suite>  # a single suite, e.g. bench:pente, bench:flyover, bench:collab
```

## Layout

| Folder | What it checks | Commands |
|---|---|---|
| `run-all-benchmarks.ts`, [`core/`](core), [`suites/`](suites) | Performance suites per domain (weather, slopes, altitude, snow, BRouter profiles, pace engine, LiDAR, POI, exporters, chart series, server, flyover), with thresholds. Each run is compared with the previous report and the machine state. | `npm run bench`, `npm run bench:quick`, `npm run bench:<suite>` |
| [`regression/`](regression) | Offline correctness regressions on real code paths: `.redview` files, project layers, co-editing simulator, POI auto-sort, route elevation | `bench:redview`, `bench:project-layers`, `bench:collab` (all three run in `check:full`), `bench:poi-autosort` |
| [`flyover/`](flyover), [`follow/`](follow) | 3D route playback camera; live-presence follow playout, both pure and replayed frame by frame in a virtual browser | `bench:flyover`, `bench:follow`, `bench:follow-frames` |
| [`avalanche/`](avalanche), [`lidar-lod/`](lidar-lod), [`snow-quality/`](snow-quality) | LiDAR viewer analyses and level of detail; the snow depth engine against physics checks and the frozen v1 engine | `bench:avalanche`, `bench:lidar-lod`, `bench:snow` |
| [`pace-accuracy/`](pace-accuracy) | Moving-time engine against real FIT rides, synthetic physics scenarios and public references | `bench:pace`, `bench:pace:prep`, `bench:pace:realism` |
| [`routing-quality/`](routing-quality), [`route-continuity/`](route-continuity) | About 660 routing scenarios against production BRouter, and the rule that a stored route never contains a straight line | `bench:routing`, `bench:routing:sweep`, `bench:routing:compare`, `bench:routing:report` |
| [`collab-load/`](collab-load), [`collab-e2e/`](collab-e2e) | Real-time server under load and across restarts; two-user journeys in a real browser, on the dev server or with production test accounts | `bench:collab-load`, `bench:collab-e2e`, `bench:collab-prod` |
| [`user-journey/`](user-journey), [`dashboard-perf/`](dashboard-perf), [`screen-audit/`](screen-audit) | Production build in a headless browser against an in-memory Appwrite: the main user journey; load, smoothness and leaks on throttled networks; layout on 15 screen sizes | `e2e:journey`, `bench:dashboard`, `bench:screens` |
| [`lidar-viewer-engines/`](lidar-viewer-engines), [`lidar-viewer-perf/`](lidar-viewer-perf), [`lidar-viewer-shots/`](lidar-viewer-shots) | LiDAR viewer on WebGPU and WebGL 2 in Chromium, Firefox and WebKit; frame rate; fixed-view captures | `bench:lidar-engines`, `bench:lidar-fps`, `bench:lidar-shots` |
| [`audit/`](audit) | Reproduction scripts of the dated audits. Each one exits non-zero while its bug reproduces. See [`docs/audits/`](../docs/audits). | `npx tsx script-test-bench/audit/<file>` |
| [`poi-external/`](poi-external) | Data study for completing the POI base from external sources (Overture, ATP, SIRENE) | See [the study](../docs/audits/2026-09-23-poi-external-sources.md) |

[`CLAUDE.md`](../CLAUDE.md) describes what each suite measures, its thresholds
and its latest reference numbers.

## Data outside the repository

The suites never read real-world data from the repository, and never from a
personal path written in the code.

| Variable | Used for | Default |
|---|---|---|
| `REDVIEW_BENCH_DATA` | One directory for every non-versioned input: reference GPX routes, FIT rides, exports ([`core/data-paths.ts`](core/data-paths.ts)) | your `Downloads` folder |
| `PACE_FIT_DIR`, `AUDIT_GPX_DIR`, `PACE_GT20`, `PACE_VICTOR_DIR` | Override one input of a given suite. They take precedence over `REDVIEW_BENCH_DATA`. | — |
| `POI_STUDY_DIR` | Intermediate files of the POI study ([`poi-external/paths.py`](poi-external/paths.py)) | a folder in the system temp directory |

Suites that need production credentials (test accounts, an SSH tunnel to the
VPS) say so in their header and read them from outside the repository.

## Reports

Runs write their reports to `script-test-bench/reports/`, which git ignores.
Reference results worth keeping are archived in
[`docs/operations/server-perf/`](../docs/operations/server-perf) and
[`docs/audits/data/`](../docs/audits/data).

## Conventions

- A suite fails with a non-zero exit code on a regression. Before a threshold
  counts as failed, it is measured again once.
- Each suite in `suites/` exports a `run…Benchmark()` function. `run-all-benchmarks.ts`
  calls it, and it can also run alone (`npm run bench:<suite>`).
- Timings taken on a laptop on battery are noise. Compare interleaved A/B runs.
