import proj4 from 'proj4';

/**
 * Pays-Bas : Amersfoort / RD New (EPSG:28992), altitudes NAP. Les 7
 * paramètres vers WGS84 (précision ~1 m) suffisent au géoréférencement des
 * overlays et des orthophotos ; les points eux-mêmes restent en RD.
 */

export const PROJ_RD_NEW = 'EPSG:28992';
const PROJ_WGS84 = 'EPSG:4326';

proj4.defs(
  PROJ_RD_NEW,
  '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 ' +
    '+ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs +type=crs',
);

/** Convert RD New (x, y) in metres to WGS84 [lon, lat]. */
export function rdToWgs84(x: number, y: number): [number, number] {
  return proj4(PROJ_RD_NEW, PROJ_WGS84, [x, y]) as [number, number];
}

/** Convert WGS84 [lon, lat] to RD New [x, y] in metres. */
export function wgs84ToRd(lon: number, lat: number): [number, number] {
  return proj4(PROJ_WGS84, PROJ_RD_NEW, [lon, lat]) as [number, number];
}
