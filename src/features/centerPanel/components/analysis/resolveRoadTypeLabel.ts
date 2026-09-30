import type { Map as MapboxMap } from 'mapbox-gl';
import { translateAppText } from '@/shared/i18n';

/** Classes de route Mapbox (source-layer `road`) → libellé affiché. */
const ROAD_CLASS_LABELS: Record<string, string> = {
  motorway: 'Autoroute',
  motorway_link: 'Autoroute',
  trunk: 'Voie rapide',
  trunk_link: 'Voie rapide',
  primary: 'Route nationale',
  primary_link: 'Route nationale',
  secondary: 'Route départementale',
  secondary_link: 'Route départementale',
  tertiary: 'Route secondaire',
  tertiary_link: 'Route secondaire',
  street: 'Rue',
  street_limited: 'Rue',
  minor: 'Route locale',
  service: 'Voie de service',
  track: 'Chemin de terre',
  path: 'Sentier',
  pedestrian: 'Voie piétonne',
};

const ROAD_QUERY_RADIUS_PX = 6;

/** Type de route sous le point cliqué (tuiles vectorielles Mapbox). */
export function resolveRoadTypeLabel(map: MapboxMap, lng: number, lat: number): string | null {
  try {
    const { x, y } = map.project([lng, lat]);
    const features = map.queryRenderedFeatures([
      [x - ROAD_QUERY_RADIUS_PX, y - ROAD_QUERY_RADIUS_PX],
      [x + ROAD_QUERY_RADIUS_PX, y + ROAD_QUERY_RADIUS_PX],
    ]);
    for (const feature of features) {
      const roadClass = feature.properties?.class;
      if (typeof roadClass !== 'string') continue;
      const label = ROAD_CLASS_LABELS[roadClass];
      if (label) return translateAppText(label);
    }
  } catch {
    /* noop */
  }
  return null;
}
