// ---------------------------------------------------------------------------
// Compatibility adapter for the global DEM fallback.
//
// Existing callers still invoke `fetchMapboxTile(...)`, but that name is now
// historical only: the live implementation uses AWS Open Data Terrarium and
// never calls Mapbox terrain-DEM v1 anymore.
// ---------------------------------------------------------------------------

// Native max zoom of the public global fallback dataset. Upstream code already
// handles parent-overzoom above this level.
const MAPBOX_DEM_MAXZOOM = 14;

async function fetchMapboxTile(z, x, y) {
  return fetchAWSTerrainTile(z, x, y);
}
