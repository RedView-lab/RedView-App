/**
 * swissSURFACE3D point cloud tile types.
 *
 * Tiles are 1 km × 1 km in CH1903+ / LV95 (EPSG:2056), height ref LN02 (EPSG:5728).
 * Tile ID is built from the south-west corner kilometer coordinates, e.g.
 *   swisssurface3d_<year>_<easting_km>-<northing_km>
 *   swisssurface3d_2015_2494-1140
 */

/** SW-corner of a 1 km × 1 km swissSURFACE3D tile, expressed in LV95 km. */
export interface SwissTileCoord {
  /** East coordinate of SW corner, in km (e.g. 2494 for E = 2 494 000 m). */
  eastKm: number;
  /** North coordinate of SW corner, in km (e.g. 1140 for N = 1 140 000 m). */
  northKm: number;
}

/** STAC item describing one available swissSURFACE3D tile. */
export interface SwissTileStacItem {
  id: string;
  /** Acquisition year extracted from the item id (e.g. 2015, 2019, 2024). */
  year: number;
  coord: SwissTileCoord;
  /** Direct download URL of the .las.zip asset. */
  href: string;
  /** Asset content-type, typically `application/vnd.laszip`. */
  contentType?: string;
  /** ISO datetime of acquisition. */
  datetime?: string;
}
