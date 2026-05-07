export const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';

export const IGN_LAYERS = {
  ORTHOPHOTO: 'HR.ORTHOIMAGERY.ORTHOPHOTOS',
  // MNS LiDAR HD (surface model with trees/buildings) — much more precise than MNT bare-ground
  ELEVATION_MNS: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS',
} as const;

// Ortho uses Web Mercator (EPSG:3857)
export const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';

// MNS LiDAR HD uses WGS84 Geographic (EPSG:4326), zoom 4-17
export const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
export const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

export const FRANCE_BOUNDS: [number, number, number, number] = [-5.5, 41.0, 10.0, 51.5];

export const IGN_ORTHO_MINZOOM = 6;
export const IGN_ORTHO_MAXZOOM = 19;

export const IGN_DEM_MINZOOM = 4;
export const IGN_DEM_MAXZOOM = 17;

// The raster-dem source is declared up to z17 so Mapbox actually requests
// the IGN MNS LiDAR HD tiles at their native resolution (~2.5 m/px at lat
// 48° in Paris). Anything lower meant the GPU overzoomed a smoothed z15
// mesh, which washed out building/tree ridges encoded by the surface
// model — visible in oblique views as a flat city with only the ground
// relief showing through.
//
// The SW handles z16/z17 inside France via the IGN MNS pipeline (see
// `IGN_DEM_MAXZOOM = 17` in sw-dem/core/config.js). Outside France the
// SW serves the bicubic-overzoomed AWS Terrarium parent (same path it
// already used at z15) — Mapbox GL then GPU-overzooms the last stable
// mesh, identical to the previous behaviour but starting from a higher
// base, so global terrain quality is unchanged.
export const DEM_SOURCE_MAXZOOM = 17;

export const DEM_TILE_SIZE = 512;
export const DEM_NODATA_THRESHOLD = -10000;
