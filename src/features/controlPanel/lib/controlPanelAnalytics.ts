import type { AnalyticsEvent, MapLayer } from '@/shared/lib/analytics';

import type { ControlPanelPersistedState } from './persistedState';

/**
 * Mesure d'audience des couches de la carte : un seul point de passage
 * (`updateProjectControlPanel`), un diff pur de l'état du panneau avant/après.
 * Une écriture qui ne change rien (hydratation, resynchronisation) ne produit
 * aucun événement.
 */

const TOGGLE_LAYERS: ReadonlyArray<[keyof ControlPanelPersistedState['toggles'], MapLayer]> = [
  ['labelsEnabled', 'labels'],
  ['contourLinesEnabled', 'contours'],
  ['slopesEnabled', 'slopes'],
  ['altitudeEnabled', 'altitude'],
  ['weatherEnabled', 'weather'],
  ['windEnabled', 'wind'],
  ['snowEnabled', 'snow'],
  ['sunlightEnabled', 'sunlight'],
  ['routesEnabled', 'routes'],
];

const BASEMAP_ID_PATTERN = /^[a-z0-9_-]{1,32}$/;

export function diffControlPanelForAnalytics(
  prev: Pick<ControlPanelPersistedState, 'toggles' | 'basemapId'> | null | undefined,
  next: Pick<ControlPanelPersistedState, 'toggles' | 'basemapId'>,
): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = [];
  for (const [key, layer] of TOGGLE_LAYERS) {
    const before = prev?.toggles?.[key];
    const after = next.toggles?.[key];
    if (typeof after === 'boolean' && typeof before === 'boolean' && before !== after) {
      events.push({ name: 'layer_toggled', data: { layer, enabled: after } });
    }
  }
  const basemap = next.basemapId;
  if (prev && typeof basemap === 'string' && basemap !== prev.basemapId && BASEMAP_ID_PATTERN.test(basemap)) {
    events.push({ name: 'basemap_changed', data: { basemap } });
  }
  return events;
}
