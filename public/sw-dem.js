// ---------------------------------------------------------------------------
// Service Worker — Client-side DEM + Ortho + Slope + Altitude tile processor
//
// THIN ENTRY POINT — only loads sub-modules via importScripts(). All real
// logic lives under /sw-dem/ subfolders grouped by responsibility:
//
//   /sw-dem/core/               — config, geometry, interpolation, RGB decode.
//   /sw-dem/sources/            — IGN / AWS / Mapbox / ortho / VHR ortho fetch adapters.
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
// Current: dem-tiles-v54-rgb-up-rle / radar-v3 / dem-negative-v30 / slope-tiles-v3-rle / vhr-tiles-v1 / altitude-stale-v1
// 2026-10-07 ortho-transparent-literal: a missing ortho tile is answered with
// the checked TRANSPARENT_PNG literal (runtime/dem-helpers.js) instead of an
// OffscreenCanvas encode, which could reject the fetch (audit d-sw-router,
// 15 failures → 0). Tile bytes for real tiles unchanged.
// 2026-10-07 dem-rgb-up-rle: the Terrain-RGB DEM tile (encodeTerrainRGBPng)
// is RGB with PNG's Up filter, compressed by zlibDeflateRle, instead of RGBA
// unfiltered through CompressionStream's level 6: 1.7-3.3× faster to encode
// and 10-36 % smaller in Chromium (real Terrarium tiles and a noisy 0.40 m-like
// surface), same elevations. Old tiles stay valid (any decoder reads both) —
// MAP_CACHE_EPOCH not bumped.
// 2026-10-06 slope-rle: the opaque gray slope tile (buildGrayPng) is
// compressed by zlibDeflateRle (core/terrain-rgb.js: distance-1 matches +
// dynamic Huffman, zlib's Z_RLE) instead of CompressionStream's level 6,
// whose match search cost 20-33 ms per 512² tile in Chromium for the same
// size; the whole slope tile build went from 24 to 11 ms. Same pixels,
// different PNG bytes: cached tiles stay valid — MAP_CACHE_EPOCH not bumped.
// 2026-10-04 video-final: the LiDAR HD WMS rasters are dispatched under a
// bytes-in-flight budget (ign-scheduler.js) instead of up to 64 at once — on
// a ~2 MB/s line they crossed the 15 s fetch timeout and the tiles fell back
// to stand-ins (42 % of a 0.40 m flyover video's relief). The flyover video's
// terrain requests (`rv-src=video`) skip the stand-ins and retry a
// provisional build for up to 30 s (dem-handler/index.js). Tile bytes
// unchanged — MAP_CACHE_EPOCH not bumped.
// 2026-10-03 altitude-stale: an /altitude-tiles request whose DEM tile was not
// final yet (LiDAR pending under load, cancelled build, stand-in) answered a
// transparent tile that Mapbox kept for good — holes in the altitude overlay
// on a cold load. It now serves the cached ancestor DEM overzoomed, uncached,
// and the page reloads the source on ALTITUDE_TILES_STALE when the real tile
// lands (tracker shared with slope: runtime/derived-tile-stale.js). Tile
// bytes unchanged — MAP_CACHE_EPOCH not bumped.
// 2026-10-03 module-split: sources/ign-fetcher.js, processing/build-tile.js and
// runtime/lifecycle.js split into smaller scripts (same code, new
// importScripts list). Tile bytes unchanged — MAP_CACHE_EPOCH not bumped.
// 2026-10-02 gesture-cancel: a camera gesture (rotate, pitch, pan, zoom) no
// longer flushes/aborts the LiDAR fetches of the terrain tiles still on
// screen — they used to fall back to the correlation MNS / AWS 30 m and stay
// cached that way (relief "jumping" to 30 m when turning the camera). The
// page posts the DEM tiles it still waits on (DEM_WANTED_TILES): only the
// others' work is dropped. A cancelled fetch is retried or answered 204
// uncached, never committed as a fallback; a legacy-MNS surface is
// provisional (short cache + WMS recovery). MAP_CACHE_EPOCH bumped (purge).
// 2026-10-02 vhr-ortho: /vhr-tiles overlay (satellite basemap, z18–21, 512 px) —
// IGN PCRS 5 cm + THR 5–10 cm via WMS-R in EPSG:3857, gated by per-layer
// z14 coverage masks, transparent elsewhere so Mapbox Satellite shows.
// 2026-10-01 slope-terrain-aligned: the overlay requests the 3D terrain's own
// DEM tiles (z = floor(zoom − 1) instead of round(zoom + 1): 16–64× fewer DEM
// builds), slope 2× Catmull-Rom gray+alpha, per-row cell size, in-flight
// neighbours awaited, provisional tiles rebuilt when the missing DEM lands,
// parent-slope fallback instead of holes, no gesture cancellation (slope and
// altitude passthrough), stand-in DEMs no longer pinned by the resolver.
// 2026-10-01 mns-1x: the 0.40 m MNS (3D basemap) is fetched at 1× again — 2×
// pushed whole viewports past the 15 s IGN timeout and the map never loaded.
// The 2× anti-aliasing stays on the 1 m terrain WMS only.
// 2026-10-01 surface-standin: a transient MNS (0.40 m) failure no longer caches
// bare earth for good — cached-parent overzoom first, every stand-in
// short-cached, background MNS recovery (buildings stayed flat on zoom-in).
// 2026-10-01 slope-lidar-wms-v2: LiDAR HD WMS fetched 2× + box-averaged (no
// more row/column hatching), 1 m terrain on LiDAR HD MNT (RGE ALTI only fills
// gaps), geopf 400 LayerNotDefined / 429 retried + WMS kept under 40 req/s,
// no 0 m plateau when a partial tile has no background, worker DEM LRU keyed
// by content, provisional slope tiles kept out of the hot tier and reloaded
// by the page (SLOPE_TILES_STALE) — placeholder holes after a gesture.
// 2026-10-01 slope-hd-outside-lidar: France border test by polygon edges (no
// more FRANCE_BOUNDS bbox → NW Italy/BE/LU/DE back on AWS), HD slope outside
// LiDAR footprints = 30 m slope (z>13 upsampled from z13), same-class
// neighbour stitching, AWS fetch-slot leak fixed, CLAIM_CLIENTS message.
// 2026-10-01 security: radar host allowlist + no raw passthrough, navigations bypass the SW.
// 2026-10-01 tiles: valid 1x1 transparent PNG (bad IDAT CRC before) + router
// rejects impossible tile coords (z>22, x/y >= 2^z) with 204.
// 2026-08 zone-gated overlays: slope/altitude tiles may carry ?zone=<hash>
// (masked, separate cache keys); analysis-zone registry + per-pixel mask (v5 Uniform Fast LiDAR).
// 2026-09-30 altitude-passthrough: /altitude-tiles (HD only) is a read-through
// alias of the DEM cache for the active profile — no altitude cache writes,
// no DEM builds above z14.
// 2026-09-30 hd-perf-1: cache-only health guard (no parent builds / overzoom
// round-trip), bounded decode LRU seeded by the encoder, centre-first WMS
// scheduling, static routes (non-tile requests bypass the SW). Tile bytes
// unchanged — MAP_CACHE_EPOCH intentionally not bumped.
// ---------------------------------------------------------------------------

const swModuleEpoch = new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base';
const withEpoch = (path) => `${path}?rv-map-cache-epoch=${encodeURIComponent(swModuleEpoch)}`;

importScripts(
  // ── Pipeline primitives (config + math + low-level fetchers) ──────────
  withEpoch('/sw-dem/core/logger.js'),
  withEpoch('/sw-dem/core/config.js'),
  withEpoch('/sw-dem/core/geo.js'),
  withEpoch('/sw-dem/core/analysis-zone.js'),
  withEpoch('/sw-dem/core/interpolation.js'),
  withEpoch('/sw-dem/core/terrain-rgb.js'),
  withEpoch('/sw-dem/sources/ign-scheduler.js'),
  withEpoch('/sw-dem/sources/ign-network.js'),
  withEpoch('/sw-dem/sources/ign-cancel.js'),
  withEpoch('/sw-dem/sources/ign-fetcher.js'),
  withEpoch('/sw-dem/sources/ign-highres.js'),
  withEpoch('/sw-dem/sources/ign-wms-raster.js'),
  withEpoch('/sw-dem/sources/ign-wms-tiles.js'),
  withEpoch('/sw-dem/sources/mapbox.js'),
  withEpoch('/sw-dem/sources/aws-terrain.js'),
  withEpoch('/sw-dem/processing/build-tile-support.js'),
  withEpoch('/sw-dem/processing/build-tile.js'),
  withEpoch('/sw-dem/processing/build-fallback-tile.js'),
  withEpoch('/sw-dem/processing/build-terrain-tile.js'),
  withEpoch('/sw-dem/processing/composite.js'),
  withEpoch('/sw-dem/sources/ortho.js'),
  withEpoch('/sw-dem/sources/vhr-ortho.js'),
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
  // defined in any order. We list the hot caches, build queues (global
  // in-flight Maps + composite limiter) and lifecycle first, then helpers,
  // then handlers, then the router (which only registers a listener).
  //
  // slope-pool.js (the dedicated Worker pool manager) MUST load before
  // slope-handler.js — handleSlopeRequest references computeSlopeViaPool
  // at call time, and cancelSlopeWork() (in lifecycle.js) references
  // cancelAllSlopePoolJobs. Both are plain function declarations, so the
  // actual call sites run well after this importScripts block finishes,
  // but keeping the order stable makes the dependency obvious.
  withEpoch('/sw-dem/workers/slope-math.js'),
  withEpoch('/sw-dem/runtime/hot-caches.js'),
  withEpoch('/sw-dem/runtime/build-queues.js'),
  withEpoch('/sw-dem/runtime/lifecycle.js'),
  withEpoch('/sw-dem/runtime/dem-helpers.js'),
  withEpoch('/sw-dem/runtime/dem-health.js'),
  withEpoch('/sw-dem/runtime/upgrade-scheduler.js'),
  // Before slope-handler.js / altitude-handler.js: both create their stale
  // tracker at evaluation time.
  withEpoch('/sw-dem/runtime/derived-tile-stale.js'),
  withEpoch('/sw-dem/runtime/dem-handler.js'),
  withEpoch('/sw-dem/runtime/slope-pool.js'),
  withEpoch('/sw-dem/runtime/slope-handler.js'),
  withEpoch('/sw-dem/runtime/altitude-handler.js'),
  withEpoch('/sw-dem/runtime/radar-handler.js'),
  withEpoch('/sw-dem/runtime/router.js'),
);
