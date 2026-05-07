// ---------------------------------------------------------------------------
// Compatibility adapter for the global DEM fallback.
//
// Existing callers still invoke `fetchMapboxTile(...)`, but that name is now
// historical only: the live implementation uses AWS Open Data Terrarium and
// never calls Mapbox terrain-DEM v1 anymore.
// ---------------------------------------------------------------------------

// AWS-fill engagement ceiling for the global DEM fallback path.
//
// This is intentionally LOWER than `DEM_SOURCE_MAXZOOM` (= 17 in
// ign.config.ts). It is NOT the source maxzoom — it is the threshold
// above which the SW must NOT mix global 30 m AWS data into IGN tiles.
// At mercZ > 15 in France we serve pure IGN MNS LiDAR HD (or bicubic-
// overzoomed parent IGN); contaminating those tiles with AWS would
// recreate the "30 m smear" the user reported on building/tree
// surfaces.
//
// AWS Terrarium is itself native only to z14; at z15 the SW
// bicubic-overzooms the z14 parent which preserves enough relief for
// the source contract. Beyond z15, both inside and outside France, the
// rendering pipeline relies on either real IGN MNS (France) or
// Mapbox GL's own GPU overzoom of the last successfully built tile.
const MAPBOX_DEM_MAXZOOM = 15;

async function fetchMapboxTile(z, x, y) {
  return fetchAWSTerrainTile(z, x, y);
}
