/**
 * Types des tuiles de nuages de points swissSURFACE3D.
 *
 * Tuiles de 1 km × 1 km en CH1903+ / LV95 (EPSG:2056), référence altimétrique LN02 (EPSG:5728).
 * L'id de tuile est construit à partir des coordonnées en km du coin sud-ouest, par ex.
 *   swisssurface3d_<year>_<easting_km>-<northing_km>
 *   swisssurface3d_2015_2494-1140
 */

/** Coin SO d'une tuile swissSURFACE3D de 1 km × 1 km, en km LV95. */
export interface SwissTileCoord {
  /** Coordonnée est du coin SO, en km (par ex. 2494 pour E = 2 494 000 m). */
  eastKm: number;
  /** Coordonnée nord du coin SO, en km (par ex. 1140 pour N = 1 140 000 m). */
  northKm: number;
}

/** STAC item describing one available swissSURFACE3D tile. */
export interface SwissTileStacItem {
  id: string;
  /** Année d'acquisition tirée de l'id de l'item (par ex. 2015, 2019, 2024). */
  year: number;
  coord: SwissTileCoord;
  /** URL de téléchargement directe de l'asset .las.zip. */
  href: string;
  /** Type de contenu de l'asset, en général `application/vnd.laszip`. */
  contentType?: string;
  /** Date-heure ISO de l'acquisition. */
  datetime?: string;
}
