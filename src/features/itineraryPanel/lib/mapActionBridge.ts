import type { MapContextMenuActionPayload, MapPoiDraftActionPayload } from '@/features/map3d';
import type { PoiFeature } from '@/features/poi/types';

export const ITINERARY_MAP_ACTION_EVENT = 'redview:itinerary-map-action';

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
      kind: 'poi-action';
      action:
        | 'start-here'
        | 'add-waypoint'
        | 'finish-here'
        | 'delete'
        | 'toggle-favorite'
        | 'toggle-pause'
        | 'toggle-manual-trace'
        | 'set-pause-duration'
        | 'cycle-pause-duration';
      feature: PoiFeature;
      extra?: {
        nextEnabled?: boolean;
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