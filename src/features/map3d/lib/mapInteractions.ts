import type { Map as MapboxMap } from 'mapbox-gl';

type InteractionHandlerName =
  | 'dragPan'
  | 'dragRotate'
  | 'scrollZoom'
  | 'boxZoom'
  | 'keyboard'
  | 'doubleClickZoom'
  | 'touchZoomRotate'
  | 'touchPitch';

const HANDLER_NAMES: readonly InteractionHandlerName[] = [
  'dragPan',
  'dragRotate',
  'scrollZoom',
  'boxZoom',
  'keyboard',
  'doubleClickZoom',
  'touchZoomRotate',
  'touchPitch',
];

/**
 * Coupe les interactions natives Mapbox (elles se battraient avec le vol) et
 * renvoie la fonction de restauration. Seuls les handlers actifs au moment de
 * la suspension sont réactivés : un outil (tracer, drag de waypoint) qui a
 * désactivé `dragPan` le retrouve désactivé.
 */
export function suspendMapInteractions(map: MapboxMap): () => void {
  const suspended = HANDLER_NAMES.filter((name) => {
    const handler = map[name];
    if (!handler?.isEnabled()) return false;
    handler.disable();
    return true;
  });

  return () => {
    for (const name of suspended) {
      map[name]?.enable();
    }
  };
}
