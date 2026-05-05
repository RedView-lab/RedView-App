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

importScripts(
  // ── Pipeline primitives (config + math + low-level fetchers) ──────────
  '/sw-dem/core/config.js',
  '/sw-dem/core/geo.js',
  '/sw-dem/core/interpolation.js',
  '/sw-dem/core/terrain-rgb.js',
  '/sw-dem/sources/ign-fetcher.js',
  '/sw-dem/sources/mapbox.js',
  '/sw-dem/sources/aws-terrain.js',
  '/sw-dem/processing/build-tile.js',
  '/sw-dem/processing/composite.js',
  '/sw-dem/sources/ortho.js',
  '/sw-dem/processing/slope.js',
  '/sw-dem/processing/altitude.js',
  // Switzerland — swissSURFACE3D Raster (COG over STAC, 0.5 m LiDAR DSM)
  '/sw-dem/swiss/swiss-config.js',
  '/sw-dem/swiss/swiss-coords.js',
  '/sw-dem/swiss/swiss-cog.js',
  '/sw-dem/swiss/swiss-fetcher.js',
  '/sw-dem/swiss/swiss-build.js',

  // ── SW orchestration (lifecycle + handlers) ───────────────────────────
  // Order matters only for declaration-before-use of `const`/`let` at
  // module evaluation time. All cross-references happen inside fetch
  // events that fire AFTER the install phase, so functions can be
  // defined in any order. We list lifecycle first (declares the global
  // in-flight Maps + composite limiter), then helpers, then handlers,
  // then the router (which only registers a listener).
  '/sw-dem/runtime/lifecycle.js',
  '/sw-dem/runtime/dem-helpers.js',
  '/sw-dem/runtime/dem-health.js',
  '/sw-dem/runtime/upgrade-scheduler.js',
  '/sw-dem/runtime/dem-handler.js',
  '/sw-dem/runtime/slope-handler.js',
  '/sw-dem/runtime/altitude-handler.js',
  '/sw-dem/runtime/router.js',
);
