// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho + Slope + Altitude tile processor
//
// THIN ENTRY POINT — only loads sub-modules via importScripts(). All real
// logic lives in /sw-dem/*.js. The split (May 03) lets each pipeline concern
// be debugged/edited independently:
//
//   /sw-dem/lifecycle.js        — install/activate/message handlers,
//                                 composite limiter, in-flight Maps
//                                 (DEM_INFLIGHT, SLOPE_INFLIGHT, ALTITUDE_INFLIGHT),
//                                 OLD_CACHES purge list.
//   /sw-dem/router.js           — single fetch listener, dispatches to
//                                 the right handler.
//   /sw-dem/dem-helpers.js      — buildDemResponse, noTileResponse,
//                                 transparentTileResponse, parent-overzoom
//                                 fallback, profile resolution, cache key
//                                 builder.
//   /sw-dem/dem-health.js       — guardDemTileHealth + nodata/anomaly
//                                 rejection logic.
//   /sw-dem/dem-handler.js      — handleDemRequest (top-level dispatcher).
//   /sw-dem/upgrade-scheduler.js — finalize() + background IGN re-cache.
//   /sw-dem/slope-handler.js    — handleSlopeRequest (uses slope.js for
//                                 the actual Horn / encoding).
//   /sw-dem/altitude-handler.js — handleAltitudeRequest.
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
  '/sw-dem/config.js',
  '/sw-dem/geo.js',
  '/sw-dem/interpolation.js',
  '/sw-dem/terrain-rgb.js',
  '/sw-dem/ign-fetcher.js',
  '/sw-dem/mapbox.js',
  '/sw-dem/aws-terrain.js',
  '/sw-dem/build-tile.js',
  '/sw-dem/composite.js',
  '/sw-dem/ortho.js',
  '/sw-dem/slope.js',
  '/sw-dem/altitude.js',
  // Switzerland — swissSURFACE3D Raster (COG over STAC, 0.5 m LiDAR DSM)
  '/sw-dem/swiss-config.js',
  '/sw-dem/swiss-coords.js',
  '/sw-dem/swiss-cog.js',
  '/sw-dem/swiss-fetcher.js',
  '/sw-dem/swiss-build.js',

  // ── SW orchestration (lifecycle + handlers) ───────────────────────────
  // Order matters only for declaration-before-use of `const`/`let` at
  // module evaluation time. All cross-references happen inside fetch
  // events that fire AFTER the install phase, so functions can be
  // defined in any order. We list lifecycle first (declares the global
  // in-flight Maps + composite limiter), then helpers, then handlers,
  // then the router (which only registers a listener).
  '/sw-dem/lifecycle.js',
  '/sw-dem/dem-helpers.js',
  '/sw-dem/dem-health.js',
  '/sw-dem/upgrade-scheduler.js',
  '/sw-dem/dem-handler.js',
  '/sw-dem/slope-handler.js',
  '/sw-dem/altitude-handler.js',
  '/sw-dem/router.js',
);
