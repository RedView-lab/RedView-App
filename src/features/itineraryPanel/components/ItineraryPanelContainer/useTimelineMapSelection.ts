import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { flyToPoi } from '@/features/map3d';
import {
  dispatchSelectPoiOnChart,
  listenOpenPoiOnMap,
} from '@/features/poi/lib/chartPoiSyncBridge';
import type { useItineraryPoiMap } from '../../hooks/useItineraryPoiMap';
import type { useItineraryCheckpointMarkers } from '../../hooks/useItineraryCheckpointMarkers';
import type { Itinerary, TimelineItem } from '../../types';
import {
  centerTimelineRowInList,
  findTimelineItemForOpenPayload,
  isCheckpointKind,
} from './timelineRowLookup';

type OpenPoiMarker = ReturnType<typeof useItineraryPoiMap>['openPoiMarker'];
type OpenCheckpointMarker = ReturnType<typeof useItineraryCheckpointMarkers>['openCheckpointMarker'];

interface UseTimelineMapSelectionOptions {
  map: MapboxMap | null;
  activeItineraryRef: MutableRefObject<Itinerary | null>;
  setSelectedTimelineIds: Dispatch<SetStateAction<string[]>>;
  openPoiMarker: OpenPoiMarker;
  openCheckpointMarker: OpenCheckpointMarker;
}

/**
 * Sélection croisée feuille de route ↔ carte ↔ graphe : un clic sur une ligne
 * ouvre son marqueur (ou survole le point), et une demande « ouvrir sur la
 * carte » venue du graphe sélectionne et centre la ligne correspondante.
 */
export function useTimelineMapSelection({
  map,
  activeItineraryRef,
  setSelectedTimelineIds,
  openPoiMarker,
  openCheckpointMarker,
}: UseTimelineMapSelectionOptions) {
  const handleSelectTimelineRow = useCallback(
    (id: string, item: TimelineItem) => {
      setSelectedTimelineIds([id]);
      if (item.kind === 'poi') {
        const opened = openPoiMarker(
          item.osmId ?? item.id,
          item.poiCategory,
          item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : undefined,
        );
        if (!opened && map && item.lat != null && item.lon != null) {
          flyToPoi(map, { lon: item.lon, lat: item.lat });
        }
      } else if (isCheckpointKind(item.kind)) {
        const opened = openCheckpointMarker(
          item.id,
          item.lat != null && item.lon != null ? { lat: item.lat, lon: item.lon } : undefined,
          { itineraryId: activeItineraryRef.current?.id, kind: item.kind },
        );
        if (!opened && map && item.lat != null && item.lon != null) {
          flyToPoi(map, { lon: item.lon, lat: item.lat });
        }
      } else if (map && item.lat != null && item.lon != null) {
        flyToPoi(map, { lon: item.lon, lat: item.lat });
      }

      dispatchSelectPoiOnChart({
        id: item.id,
        osmId: item.osmId,
        lat: item.lat,
        lon: item.lon,
        distanceKm: item.distanceKm,
        category: item.poiCategory,
        itineraryId: activeItineraryRef.current?.id,
        source: 'timeline',
      });
    },
    [activeItineraryRef, map, openPoiMarker, openCheckpointMarker, setSelectedTimelineIds],
  );

  useEffect(() => {
    return listenOpenPoiOnMap((payload) => {
      const currentActive = activeItineraryRef.current;
      if (!currentActive) return;

      const matchingItem = findTimelineItemForOpenPayload(currentActive.timeline, payload);

      if (matchingItem) {
        setSelectedTimelineIds([matchingItem.id]);
        centerTimelineRowInList(matchingItem.id);
        if (matchingItem.kind === 'poi') {
          openPoiMarker(
            matchingItem.osmId ?? matchingItem.id,
            matchingItem.poiCategory,
            matchingItem.lat != null && matchingItem.lon != null
              ? { lat: matchingItem.lat, lon: matchingItem.lon }
              : undefined,
          );
        } else if (isCheckpointKind(matchingItem.kind)) {
          openCheckpointMarker(
            matchingItem.id,
            matchingItem.lat != null && matchingItem.lon != null
              ? { lat: matchingItem.lat, lon: matchingItem.lon }
              : undefined,
            { itineraryId: currentActive.id, kind: matchingItem.kind },
          );
        }
      } else if (payload.lat != null && payload.lon != null) {
        const opened = openPoiMarker(
          payload.osmId ?? payload.id ?? '',
          payload.category,
          { lat: payload.lat, lon: payload.lon },
        );
        if (!opened) {
          openCheckpointMarker(
            String(payload.id ?? ''),
            { lat: payload.lat, lon: payload.lon },
            { itineraryId: payload.itineraryId ?? currentActive.id },
          );
        }
      }
    });
  }, [activeItineraryRef, openPoiMarker, openCheckpointMarker, setSelectedTimelineIds]);

  return { handleSelectTimelineRow };
}
