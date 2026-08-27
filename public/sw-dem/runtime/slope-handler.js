// ---------------------------------------------------------------------------
// Slope tile handler loader — stable root entry kept for service-worker load
// order, cache friendliness and backwards-compatible import paths.
//
// The implementation now lives under /runtime/slope-handler/.
// ---------------------------------------------------------------------------

importScripts(
  '/sw-dem/runtime/slope-handler/slope-helpers.js',
  '/sw-dem/runtime/slope-handler/slope-lidar-dem.js',
  '/sw-dem/runtime/slope-handler/slope-builders.js',
  '/sw-dem/runtime/slope-handler/slope-request.js',
  '/sw-dem/runtime/slope-handler/slope-zone-pipeline.js',
);
