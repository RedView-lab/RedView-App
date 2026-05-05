// ---------------------------------------------------------------------------
// Compatibility adapter for the global DEM fallback.
//
// Existing callers still invoke `fetchMapboxTile(...)`, but that name is now
// historical only: the live implementation uses AWS Open Data Terrarium and
// never calls Mapbox terrain-DEM v1 anymore.
// ---------------------------------------------------------------------------

// Must match DEM_SOURCE_MAXZOOM (ign.config.ts) — the maxzoom declared on the
// raster-dem source. The SW must serve real elevation tiles at every zoom level
// Mapbox can request. Returning 204 at maxzoom makes the terrain flat because
// Mapbox's GPU overzooming starts from the maxzoom tile (which would be empty).
// AWS Terrarium native is z14; at z15 the SW bicubic-overzooms the z14 parent
// which preserves relief much better than an empty 204 slot.
const MAPBOX_DEM_MAXZOOM = 15;

async function fetchMapboxTile(z, x, y) {
  return fetchAWSTerrainTile(z, x, y);
}
