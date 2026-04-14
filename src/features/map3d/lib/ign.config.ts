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

// Mapbox requests tiles up to this zoom from our protocol.
// IGN MNS LiDAR HD goes up to z17 WGS84G; higher Mercator zooms use bicubic upsampling + Mapbox composite.
export const DEM_SOURCE_MAXZOOM = 17;

export const DEM_TILE_SIZE = 512;
export const DEM_NODATA_THRESHOLD = -10000;
