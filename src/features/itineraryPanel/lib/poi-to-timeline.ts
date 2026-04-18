/**
 * Convert POI corridor results into Timeline rows.
 *
 * - Maps OSM/Overpass categories back onto the panel's POI taxonomy
 *   (Figma rows: Eau, Boulangerie, Supermarché, …).
 * - Projects each POI onto the active GPX route to derive a
 *   `distanceKm` from the start, so the rows can be inserted in
 *   physical order between the Départ and Fin checkpoints.
 */
import type { PoiFeature, PoiCategory as FeaturePoiCategory } from '@/features/poi/types';
import { POI_LABELS } from '@/features/poi/types';

import type { PoiCategory as PanelPoiCategory, TimelineItem } from '../types';

/** OSM/Overpass → panel category. Anything not listed here is dropped. */
export const FEATURE_TO_PANEL_POI: Partial<Record<FeaturePoiCategory, PanelPoiCategory>> = {
  drinking_water: 'fountains',
  toilets: 'toilets',
  supermarket: 'supermarkets',
  convenience: 'supermarkets',
  bakery: 'bakeries',
  bicycle: 'bikeShops',
  bicycle_repair: 'bikeShops',
  shelter: 'refuges',
  camp_site: 'refuges',
};

const EARTH_R_M = 6_371_008.8;
const DEG = Math.PI / 180;

function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(h));
}

/**
 * Project a POI onto the polyline; returns the cumulative distance from
 * the start of the route to the closest point on the nearest segment.
 *
 * Uses an equirectangular approximation around each segment midpoint —
 * accurate to a few metres for corridor-scale POI distances.
 */
function projectDistanceM(
  poi: { lat: number; lon: number },
  cumLenM: number[],
  pts: { lat: number; lon: number }[],
): number {
  let bestD2 = Infinity;
  let bestSegStart = 0;
  let bestT = 0;

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const midLat = (a.lat + b.lat) / 2;
    const cosLat = Math.cos(midLat * DEG);
    const ax = a.lon * cosLat;
    const ay = a.lat;
    const bx = b.lon * cosLat;
    const by = b.lat;
    const px = poi.lon * cosLat;
    const py = poi.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const segLen2 = dx * dx + dy * dy;
    let t = 0;
    if (segLen2 > 0) {
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / segLen2));
    }
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const ex = px - cx;
    const ey = py - cy;
    const d2 = ex * ex + ey * ey;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestSegStart = i - 1;
      bestT = t;
    }
  }

  const segLenM = cumLenM[bestSegStart + 1] - cumLenM[bestSegStart];
  return cumLenM[bestSegStart] + bestT * segLenM;
}

/** Pre-compute cumulative length so projection is O(N) instead of O(N²). */
function cumulativeLengthsM(pts: { lat: number; lon: number }[]): number[] {
  const out = new Array<number>(pts.length);
  out[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    out[i] = out[i - 1] + haversineM(pts[i - 1], pts[i]);
  }
  return out;
}

/**
 * Convert POI features into ordered TimelineItems with `kind: 'poi'`.
 *
 * Items are sorted by their projected distance along the route so they
 * fall in physical order when inserted between Départ and Fin.
 */
export function poiFeaturesToTimelineItems(
  features: PoiFeature[],
  routePoints: { lat: number; lon: number }[],
): TimelineItem[] {
  if (features.length === 0 || routePoints.length < 2) return [];

  const cum = cumulativeLengthsM(routePoints);

  const rows: TimelineItem[] = [];
  for (const f of features) {
    const panelKey = FEATURE_TO_PANEL_POI[f.category];
    if (!panelKey) continue;
    const distM = projectDistanceM({ lat: f.lat, lon: f.lon }, cum, routePoints);
    rows.push({
      id: `poi-${f.id}`,
      kind: 'poi',
      label: f.name?.trim() || POI_LABELS[f.category] || 'POI',
      distanceKm: Math.round(distM / 100) / 10,
      lat: f.lat,
      lon: f.lon,
      poiCategory: panelKey,
      osmId: f.id,
      visible: true,
    });
  }

  rows.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  return rows;
}
