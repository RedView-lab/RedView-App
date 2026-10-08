import type { Map as MapboxMap, Marker } from 'mapbox-gl';
import {
  getRouteElevationContext,
  setAnalysisFlyoverProgress,
  setAnalysisFlyoverRoute,
  setRouteLayerVisibility,
} from '@/features/itineraryPanel/lib/route-layer';
import { setPoiLayersSuppressed } from '@/features/poi/lib/poi-markers';
import { createRouteDotMarker } from '../../components/analysis/routeDotMarker';
import type { CameraRail } from '../engine/cameraRail';
import type { TrackCursor, TrackPosition } from '../engine/routeTrack';
import type { FlyoverRouteInput } from '../types';

/** Ce que la carte montre d'une session de lecture : trace, couleur, tête et avancement. */
export interface FlyoverMapSession {
  readonly route: FlyoverRouteInput;
  readonly rail: CameraRail;
  readonly cursor: TrackCursor;
  marker: Marker | null;
  color: string;
  distanceM: number;
  /** Plus loin atteint (mesure d'audience : part du parcours vue). */
  maxDistanceM: number;
  layerSignature: string;
}

/** La carte a encore un style (pas détruite ni en cours de remplacement de style). */
export function isMapAlive(map: MapboxMap): boolean {
  return Boolean((map as unknown as { style?: unknown }).style);
}

/** Masque le tracé normal de l'itinéraire, les POI et les marqueurs de la carte (sauf la tête). */
export function hideFlyoverNonTraceOverlays(map: MapboxMap, session: FlyoverMapSession): void {
  setRouteLayerVisibility(map, session.route.itineraryId, false);
  setPoiLayersSuppressed(map, true);
  map.getContainer().dataset.rvFlyoverSession = '';
}

/** Avance la tête et la traînée jusqu'à `distanceM` ; crée le marqueur de tête au premier appel. */
export function placeFlyoverHead(map: MapboxMap, session: FlyoverMapSession, distanceM: number, scratch: TrackPosition): void {
  session.distanceM = distanceM;
  if (distanceM > session.maxDistanceM) session.maxDistanceM = distanceM;
  const head = session.cursor.locate(distanceM, scratch);
  if (!isMapAlive(map)) return;
  setAnalysisFlyoverProgress(map, distanceM >= session.rail.lengthM ? 1 : head.lineProgress);
  if (session.marker) {
    session.marker.setLngLat([head.lng, head.lat]);
  } else {
    session.marker = createRouteDotMarker(map, [head.lng, head.lat], session.color);
    // Seul marqueur laissé visible pendant la lecture.
    session.marker.getElement().dataset.rvFlyoverHead = '';
  }
}

/**
 * La lecture ne montre que la trace : trace complète du flyover posée,
 * tracé normal masqué, POI masqués, marqueurs et popups de la carte cachés
 * (`[data-rv-flyover-session]`, src/index.css) sauf la tête. Rejoué après
 * un changement de style.
 */
export function mountFlyoverLayers(map: MapboxMap, session: FlyoverMapSession, scratch: TrackPosition): void {
  if (!isMapAlive(map)) return;
  const mounted = setAnalysisFlyoverRoute(map, session.route.points, session.color);
  session.layerSignature = mounted ? getRouteElevationContext(map).signature : '';
  hideFlyoverNonTraceOverlays(map, session);
  placeFlyoverHead(map, session, session.distanceM, scratch);
}
