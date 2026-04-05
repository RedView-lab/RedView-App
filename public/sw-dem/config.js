// ---------------------------------------------------------------------------
// Configuration constants — shared by all SW modules
// ---------------------------------------------------------------------------

const IGN_WMTS_BASE = 'https://data.geopf.fr/wmts';
const IGN_DEM_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES.MNS';
const IGN_DEM_TILEMATRIXSET = 'WGS84G_4_17';
const IGN_DEM_FORMAT = 'image/x-bil;bits=32';

const FRANCE_BOUNDS = [-5.5, 41.0, 10.0, 51.5];
const DEM_TILE_SIZE = 512;
const IGN_SRC_TILE_SIZE = 256;
const DEM_NODATA_THRESHOLD = -10000;
const IGN_DEM_MINZOOM = 4;
const IGN_DEM_MAXZOOM = 17;

const IGN_ORTHO_LAYER = 'HR.ORTHOIMAGERY.ORTHOPHOTOS';
const IGN_ORTHO_TILEMATRIXSET = 'PM_6_19';
const ORTHO_TILE_SIZE = 256;

const CACHE_NAME = 'dem-tiles-v7';
const NEGATIVE_CACHE_NAME = 'dem-negative-v2';
const NEGATIVE_TTL = 3600;
const ORTHO_CACHE_NAME = 'ortho-tiles-v1';
const STATIC_CACHE_NAME = 'dem-static-v1';

const IGN_CACHE_MAX = 3000;
const IGN_CONCURRENCY = 4;
