import proj4 from 'proj4';

/**
 * Belgique : Belge 1972 / Belgian Lambert 72 (EPSG:31370), altitudes TAW/DNG.
 * Les 7 paramètres vers WGS84 (précision ~1 m) suffisent au géoréférencement
 * des overlays et des orthophotos ; les points eux-mêmes restent en Lambert 72.
 */

export const PROJ_BL72 = 'EPSG:31370';

proj4.defs(
  PROJ_BL72,
  '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 ' +
    '+x_0=150000.013 +y_0=5400088.438 +ellps=intl ' +
    '+towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs +type=crs',
);

