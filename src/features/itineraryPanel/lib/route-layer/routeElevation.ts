import type { Map as MapboxMap } from 'mapbox-gl';

export const LINE_CLEARANCE_M = 2.4;
export const ROUTE_SELECTION_CLEARANCE_M = 2.5;

/**
 * Sous ce zoom, le tracé est une ligne drapée (non élevée). Mapbox saute
 * entièrement les lignes élevées sur le globe, qui devient Mercator au zoom 6 ;
 * la marge d'un demi-niveau bascule les couches avant la projection, pendant que
 * les deux sortes s'affichent encore : un dézoom ne montre ainsi jamais une
 * image sans tracé.
 */
export const ROUTE_ELEVATED_MIN_ZOOM = 6.5;

export type RouteLineElevationReference = 'ground' | 'none';

/**
 * Chaque ligne de tracé (trace, liseré, motifs de surface, sélection, flyover)
 * est élevée depuis le terrain lui-même : `ground` fait lire à Mapbox, par
 * tuile, la tuile DEM même avec laquelle le maillage 3D est dessiné, à chaque
 * zoom et pendant l'arrivée des tuiles HD. Un profil absolu (`sea`) tiré des
 * altitudes sol nu du tracé s'enfonçait sous le modèle de surface HD (canopée,
 * bâtiments, déblais de route entre les sommets du maillage) : jusqu'à la moitié
 * de la trace visible était cachée par le relief et ne revenait qu'à un autre
 * niveau de zoom.
 */
export function getRouteElevationContext(map: MapboxMap): {
  elevated: boolean;
  signature: string;
} {
  const elevated = Boolean(map.getTerrain()?.source) && map.getZoom() >= ROUTE_ELEVATED_MIN_ZOOM;
  return { elevated, signature: elevated ? 'ground' : 'flat' };
}

export function getRouteLineElevation(
  map: MapboxMap,
  clearanceM: number = LINE_CLEARANCE_M,
): { reference: RouteLineElevationReference; zOffset: number } {
  return getRouteElevationContext(map).elevated
    ? { reference: 'ground', zOffset: clearanceM }
    : { reference: 'none', zOffset: 0 };
}
