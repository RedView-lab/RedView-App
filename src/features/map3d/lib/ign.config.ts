export const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';

export const IGN_LAYERS = {
  ORTHOPHOTO: 'HR.ORTHOIMAGERY.ORTHOPHOTOS',
  // MNT (bare ground) — not MNS (surface with trees/buildings)
  ELEVATION_MNT: 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES',
} as const;

// Ortho uses Web Mercator (EPSG:3857)
export const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';

// MNT uses WGS84 Geographic (EPSG:4326), zoom 6-14
export const IGN_DEM_TILEMATRIXSET = 'WGS84G_6_14';
export const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

export const FRANCE_BOUNDS: [number, number, number, number] = [-5.5, 41.0, 10.0, 51.5];

export const IGN_ORTHO_MINZOOM = 6;
export const IGN_ORTHO_MAXZOOM = 19;

export const IGN_DEM_MINZOOM = 6;
export const IGN_DEM_MAXZOOM = 14;

// Mapbox requests tiles up to this zoom from our protocol.
// IGN MNT maxes at z14 WGS84G; higher Mercator zooms use bicubic upsampling + Mapbox composite.
export const DEM_SOURCE_MAXZOOM = 16;

export const DEM_TILE_SIZE = 512;
export const DEM_NODATA_THRESHOLD = -10000;
