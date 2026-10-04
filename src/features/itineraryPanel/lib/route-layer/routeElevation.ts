import type { Map as MapboxMap } from 'mapbox-gl';

export const LINE_CLEARANCE_M = 2.4;
export const ROUTE_SELECTION_CLEARANCE_M = 2.5;

/**
 * Below this zoom the route is a draped (non-elevated) line. Mapbox skips
 * elevated lines entirely on the globe, which becomes Mercator at zoom 6; the
 * half-level margin switches the layers before the projection does, while
 * both kinds still render, so a zoom-out never shows a frame without route.
 */
export const ROUTE_ELEVATED_MIN_ZOOM = 6.5;

export type RouteLineElevationReference = 'ground' | 'none';

/**
 * Every route line (trace, casing, surface patterns, selection, flyover) is
 * elevated from the terrain itself: `ground` makes Mapbox read, per tile, the
 * very DEM tile the 3D mesh is drawn with, at every zoom and while HD tiles
 * stream in. An absolute (`sea`) profile from the bare-earth route altitudes
 * sank under the HD surface model (canopy, buildings, road cuts between mesh
 * vertices): up to half the visible trace was hidden by the relief and came
 * back only at another zoom level.
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
