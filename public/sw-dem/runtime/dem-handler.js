// ---------------------------------------------------------------------------
// DEM tile handler loader — stable root entry kept for service-worker load
// order, cache friendliness and backwards-compatible import paths.
//
// The implementation now lives under /runtime/dem-handler/.
// ---------------------------------------------------------------------------

importScripts(
  '/sw-dem/runtime/dem-handler/compute-request.js',
  '/sw-dem/runtime/dem-handler/index.js',
);