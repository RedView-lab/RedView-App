import type { Dispatch, SetStateAction } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import type { Itinerary, ItineraryProject } from '../../types';

export type RoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];
export type RoutePoint = RoutePoints[number];

export type ProfilePoint = {
  lat: number;
  lon: number;
  distanceM: number;
  elevationM: number;
  gradientPct: number;
};

export interface UseItineraryBrouterRoutingArgs {
  active: ItineraryProject['itineraries'][number] | null;
  /** Tous les itinéraires : les éditions locales des non actifs sont routées aussi. */
  itineraries: ItineraryProject['itineraries'];
  /** Révision d'historique du ProjectStore (undo / redo / rollback). */
  historyRevision: number;
  isMapLoaded: boolean;
  map: MapboxMap | null;
  rollbackPendingTraceAppend: (itineraryId: string) => boolean;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}