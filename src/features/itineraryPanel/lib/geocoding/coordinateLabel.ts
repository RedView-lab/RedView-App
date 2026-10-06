/**
 * Libellé « lon, lat » d'un point sans nom. À part du géocodeur : les projets
 * importés l'utilisent sur le chargement initial du gestionnaire de projets,
 * qui n'a pas à embarquer le client de géocodage Mapbox.
 */
export function formatGpsCoordinateLabel(lon: number, lat: number): string {
  return `${lon.toFixed(5)}, ${lat.toFixed(5)}`;
}
