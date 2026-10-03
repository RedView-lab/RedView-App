export const FRANCE_BOUNDS: [number, number, number, number] = [-5.5, 41.0, 10.0, 51.5];

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
