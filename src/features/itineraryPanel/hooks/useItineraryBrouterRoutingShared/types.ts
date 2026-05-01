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
  isMapLoaded: boolean;
  map: MapboxMap | null;
  rollbackPendingTraceAppend: (itineraryId: string) => boolean;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}