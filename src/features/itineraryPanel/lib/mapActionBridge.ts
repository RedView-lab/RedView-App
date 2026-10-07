import type { MapContextMenuActionPayload, MapPoiDraftActionPayload } from '@/features/map3d';
import type { PoiFeature } from '@/features/poi/types';
import type { TimelineAddItemKind } from '../types';

export const ITINERARY_MAP_ACTION_EVENT = 'redview:itinerary-map-action';

/**
 * Point placed on the active route from the analysis chart (toolbar « Ajouter »).
 * A POI goes through the map's draft card instead.
 */
export interface RoutePointAddPayload {
  /** Itinerary active when the point was placed; ignored if another one is active by then. */
  itineraryId: string;
  kind: Exclude<TimelineAddItemKind, 'poi'>;
  lat: number;
  lon: number;
  /** Position along the itinerary's route, from its start. */
  distanceM: number;
  /** Row label until the place name resolves. */
  label: string;
}

export type ItineraryMapActionEventDetail =
  | {
      kind: 'context-menu';
      payload: MapContextMenuActionPayload;
    }
  | {
      kind: 'poi-draft';
      payload: MapPoiDraftActionPayload;
    }
  | {
      kind: 'route-point-add';
      payload: RoutePointAddPayload;
    }
  | {
      kind: 'poi-action';
      action:
        | 'start-here'
        | 'add-waypoint'
        | 'finish-here'
        | 'delete'
        | 'toggle-favorite'
        | 'toggle-pause'
        | 'set-pause-duration'
        | 'cycle-pause-duration';
      feature: PoiFeature;
      extra?: {
        nextEnabled?: boolean;
        /** Pause : sa durée ; favori : celle de la pause posée avec lui. */
        durationMin?: number;
      };
    };

export function dispatchItineraryMapAction(detail: ItineraryMapActionEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ItineraryMapActionEventDetail>(ITINERARY_MAP_ACTION_EVENT, {
    detail,
  }));
}

export function listenItineraryMapAction(
  listener: (detail: ItineraryMapActionEventDetail) => void,
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<ItineraryMapActionEventDetail>;
    if (!customEvent.detail) return;
    listener(customEvent.detail);
  };

  window.addEventListener(ITINERARY_MAP_ACTION_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(ITINERARY_MAP_ACTION_EVENT, handler as EventListener);
  };
}