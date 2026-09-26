import type { ExpressionSpecification, Map as MapboxMap } from 'mapbox-gl';
import { isValidElevation } from '../route-metrics/elevationSanitizer';
import type { RouteLayerPoint } from './routeStyle';

const HEIGHTS_PROPERTY = '__routeHeights';
const SAMPLE_SPACING_M = 10;
const MAX_SAMPLES = 16_384;
const LINE_CLEARANCE_M = 0.8;
export const ROUTE_SELECTION_CLEARANCE_M = 0.86;
const EARTH_RADIUS_M = 6_378_137;

// GeoJSON Z coordinates alone do not position native line layers. Evaluate an
// absolute height along each feature instead; never add the canopy DEM to it.
export const ROUTE_PROFILE_Z_OFFSET: ExpressionSpecification = [
  'at-interpolated',
  ['*', ['line-progress'], ['-', ['length', ['get', HEIGHTS_PROPERTY]], 1]],
  ['get', HEIGHTS_PROPERTY],
];

export function getRouteElevationContext(map: MapboxMap): { scale: number | null; signature: string } {
  const terrain = map.getTerrain();
  // The globe becomes Mercator at zoom 6. Elevated lines are not rendered on
  // the low-zoom globe; keep an ordinary 2D line there, without changing the map.
  const enabled = Boolean(terrain?.source) && map.getZoom() >= 6;
  const exaggeration = typeof terrain?.exaggeration === 'number' ? terrain.exaggeration : 1;
  return {
    scale: enabled ? exaggeration : null,
    signature: `${enabled ? 1 : 0}:${terrain?.source ?? ''}:${exaggeration}`,
  };
}

function mercatorY(lat: number): number {
  const radians = Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI / 180;
  return EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

/** Render-only heights. Never mutate route points, metrics, or the terrain. */
export function applyRouteElevationProfile(
  spec: {
    data: GeoJSON.Feature | GeoJSON.FeatureCollection;
    requiresLineMetrics?: boolean;
  },
  points: readonly RouteLayerPoint[],
  scale: number,
  clearanceM: number = LINE_CLEARANCE_M,
): boolean {
  if (points.length < 2) return false;
  const distances = new Float64Array(points.length);
  const anchors: { distance: number; height: number }[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) {
      // line-progress uses projected arc length, not GPX distance or vertex index.
      const dx = EARTH_RADIUS_M * (points[i].lon - points[i - 1].lon) * Math.PI / 180;
      const dy = mercatorY(points[i].lat) - mercatorY(points[i - 1].lat);
      distances[i] = distances[i - 1] + Math.hypot(dx, dy);
    }
    const height = points[i].elevationM;
    if (isValidElevation(height)) {
      const anchor = { distance: distances[i], height };
      if (anchors.at(-1)?.distance === anchor.distance) anchors[anchors.length - 1] = anchor;
      else anchors.push(anchor);
    }
  }
  // No invented sea-level profile while an elevation-less import is enriching.
  if (anchors.length === 0) return false;

  const total = distances[distances.length - 1];
  const groundScale = Math.max(0.08, Math.cos(points[0].lat * Math.PI / 180));
  const count = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil(total * groundScale / SAMPLE_SPACING_M) + 1));
  let anchorIndex = 0;
  const raw = Array.from({ length: count }, (_, index) => {
    const distance = total * index / (count - 1);
    while (anchorIndex + 1 < anchors.length && anchors[anchorIndex + 1].distance <= distance) anchorIndex += 1;
    const left = anchors[anchorIndex];
    const right = anchors[Math.min(anchorIndex + 1, anchors.length - 1)];
    const span = right.distance - left.distance;
    const t = span > 0 ? Math.max(0, Math.min(1, (distance - left.distance) / span)) : 0;
    return left.height + (right.height - left.height) * t;
  });
  // Uniform distance samples keep this independent of GPX recording density.
  // A small median removes isolated spikes; a triangular pass softens the joins.
  // Endpoints are kept, and broad climbs/descents are not flattened.
  const median = raw.map((height, i) => {
    const radius = Math.min(2, i, raw.length - 1 - i);
    const window = raw.slice(i - radius, i + radius + 1).sort((a, b) => a - b);
    return radius ? window[radius] : height;
  });
  const smooth = median.map((height, i) => (
    i === 0 || i === median.length - 1
      ? height
      : (median[i - 1] + 2 * height + median[i + 1]) / 4
  ));
  const sample = (distance: number): number => {
    const index = total > 0 ? Math.max(0, Math.min(count - 1, distance / total * (count - 1))) : 0;
    const low = Math.floor(index);
    const high = Math.min(count - 1, low + 1);
    return (smooth[low] + (smooth[high] - smooth[low]) * (index - low)) * scale + clearanceM;
  };

  // Surface runs share a boundary vertex. Sample from one global profile so
  // casing/patterns and adjoining runs meet at exactly the same altitude.
  const features = spec.data.type === 'FeatureCollection' ? spec.data.features : [spec.data];
  let startIndex = 0;
  for (const feature of features) {
    if (!feature.geometry || feature.geometry.type !== 'LineString') continue;
    const endIndex = startIndex + feature.geometry.coordinates.length - 1;
    const start = distances[startIndex];
    const end = distances[endIndex];
    const featureCount = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil((end - start) * groundScale / SAMPLE_SPACING_M) + 1));
    feature.properties = {
      ...feature.properties,
      [HEIGHTS_PROPERTY]: Array.from({ length: featureCount }, (_, i) => sample(start + (end - start) * i / (featureCount - 1))),
    };
    startIndex = endIndex;
  }
  spec.requiresLineMetrics = true;
  return true;
}
