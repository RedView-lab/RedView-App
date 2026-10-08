import type { Map as MapboxMap } from 'mapbox-gl';
import { flyToBounds, flyToLocation } from '@/features/map3d';
import { CHART_CLICK_FOCUS_PITCH, CHART_CLICK_FOCUS_ZOOM } from './shared';

/** Emprise lon/lat d'une suite de points (±Infinity si elle est vide). */
export function lonLatExtent(points: ReadonlyArray<{ lon: number; lat: number }>) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const pt of points) {
    if (pt.lon < minLon) minLon = pt.lon;
    if (pt.lon > maxLon) maxLon = pt.lon;
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

/** Inclinaison gardée par un vol depuis le graphique : 0 en vue 2D, au moins CHART_CLICK_FOCUS_PITCH sinon. */
function chartFocusPitch(map: MapboxMap): number {
  const currentPitch = map.getPitch();
  const is2D = currentPitch <= 8;
  return is2D ? 0 : Math.max(currentPitch, CHART_CLICK_FOCUS_PITCH);
}

/** Vole vers le point de la trace cliqué sur le graphique. */
export function flyMapToRoutePoint(map: MapboxMap, point: { lat: number; lon: number }): void {
  flyToLocation(
    map,
    { lon: point.lon, lat: point.lat },
    {
      zoom: CHART_CLICK_FOCUS_ZOOM,
      pitch: chartFocusPitch(map),
    },
  );
}

/** Cadre la carte sur le tronçon sélectionné sur le graphique. */
export function flyMapToRouteSegment(map: MapboxMap, segmentPoints: ReadonlyArray<{ lon: number; lat: number }>): void {
  const { minLon, maxLon, minLat, maxLat } = lonLatExtent(segmentPoints);
  flyToBounds(
    map,
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    {
      pitch: chartFocusPitch(map),
      maxZoom: 13.8,
      padding: { top: 80, bottom: 80, left: 80, right: 80 },
    },
  );
}
