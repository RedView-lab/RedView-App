// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho + Slope + Altitude tile processor
//
// THIN ENTRY POINT — only loads sub-modules via importScripts(). All real
// logic lives under /sw-dem/ subfolders grouped by responsibility:
//
//   /sw-dem/core/               — config, geometry, interpolation, RGB decode.
//   /sw-dem/sources/            — IGN / AWS / Mapbox / ortho fetch adapters.
//   /sw-dem/processing/         — tile build, composite, slope, altitude math.
//   /sw-dem/swiss/              — swissSURFACE3D config, coords, COG, fetch, build.
//   /sw-dem/norway/             — Norway NHM DTM WCS config, coords, build.
//   /sw-dem/spain/              — Spain MDT WCS config, coords, build.
//   /sw-dem/runtime/            — lifecycle, router, helpers, health, handlers.
//
// Contract with the page (useMap.ts):
//   1. page registers SW and waits for controllerchange
//   2. ONLY THEN does the page add /dem-tiles/ and /ortho-tiles/ sources
//
// Consequence: DEM fetches are entirely local/public-source driven
// (IGN/swissALTI/AWS Terrarium). We NEVER synthesize a fake "flat" elevation
// tile; on genuine misses we return 204 so the renderer can reuse parent mesh.
// ---------------------------------------------------------------------------
// Cache stamp — bumped on every cache-invalidating change so the browser
// detects a byte diff in this file and triggers install→activate→purge.
// Current: dem-tiles-v45 / dem-negative-v27 (France high-zoom transient-miss guard)
// ---------------------------------------------------------------------------

const swModuleEpoch = new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base';
const withEpoch = (path) => `${path}?rv-map-cache-epoch=${encodeURIComponent(swModuleEpoch)}`;

importScripts(
  // ── Pipeline primitives (config + math + low-level fetchers) ──────────
  withEpoch('/sw-dem/core/config.js'),
  withEpoch('/sw-dem/core/geo.js'),
  withEpoch('/sw-dem/core/interpolation.js'),
  withEpoch('/sw-dem/core/terrain-rgb.js'),
  withEpoch('/sw-dem/sources/ign-fetcher.js'),
  withEpoch('/sw-dem/sources/mapbox.js'),
  withEpoch('/sw-dem/sources/aws-terrain.js'),
  withEpoch('/sw-dem/processing/build-tile.js'),
  withEpoch('/sw-dem/processing/composite.js'),
  withEpoch('/sw-dem/sources/ortho.js'),
  withEpoch('/sw-dem/processing/slope.js'),
  withEpoch('/sw-dem/processing/altitude.js'),
  // Switzerland — swissSURFACE3D Raster (COG over STAC, 0.5 m LiDAR DSM)
  withEpoch('/sw-dem/swiss/swiss-config.js'),
  withEpoch('/sw-dem/swiss/swiss-coords.js'),
  withEpoch('/sw-dem/swiss/swiss-cog.js'),
  withEpoch('/sw-dem/swiss/swiss-fetcher.js'),
  withEpoch('/sw-dem/swiss/swiss-build.js'),
  // Norway — national DTM via Kartverket / Geonorge WCS (UTM 32/33/35)
  withEpoch('/sw-dem/norway/norway-config.js'),
  withEpoch('/sw-dem/norway/norway-coords.js'),
  withEpoch('/sw-dem/norway/norway-build.js'),
  // Spain — national MDT 5 m via IGN / IDEE WCS
  withEpoch('/sw-dem/spain/spain-config.js'),
  withEpoch('/sw-dem/spain/spain-coords.js'),
  withEpoch('/sw-dem/spain/spain-build.js'),

  // ── SW orchestration (lifecycle + handlers) ───────────────────────────
  // Order matters only for declaration-before-use of `const`/`let` at
  // module evaluation time. All cross-references happen inside fetch
  // events that fire AFTER the install phase, so functions can be
  // defined in any order. We list lifecycle first (declares the global
  // in-flight Maps + composite limiter), then helpers, then handlers,
  // then the router (which only registers a listener).
  //
  // slope-pool.js (the dedicated Worker pool manager) MUST load before
  // slope-handler.js — handleSlopeRequest references computeSlopeViaPool
  // at call time, and cancelSlopeWork() (in lifecycle.js) references
  // cancelAllSlopePoolJobs. Both are plain function declarations, so the
  // actual call sites run well after this importScripts block finishes,
  // but keeping the order stable makes the dependency obvious.
  withEpoch('/sw-dem/workers/slope-math.js'),
  withEpoch('/sw-dem/runtime/lifecycle.js'),
  withEpoch('/sw-dem/runtime/dem-helpers.js'),
  withEpoch('/sw-dem/runtime/dem-health.js'),
  withEpoch('/sw-dem/runtime/upgrade-scheduler.js'),
  withEpoch('/sw-dem/runtime/dem-handler.js'),
  withEpoch('/sw-dem/runtime/slope-pool.js'),
  withEpoch('/sw-dem/runtime/slope-handler.js'),
  withEpoch('/sw-dem/runtime/altitude-handler.js'),
  withEpoch('/sw-dem/runtime/router.js'),
);
