import { useCallback, useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  closeMarkerPopupOnSecondClick,
  flyToPoi,
  keepPopupInVisibleMap,
} from '@/features/map3d';
import type { ItineraryProject } from '../../types';
import { collectItineraryCheckpoints } from './collectCheckpoints';
import { findCheckpointMarkerEntry } from './findMarkerEntry';
import { applyTracePointDataset, createMarkerElement, updateMarkerElement } from './markerElement';
import { applyMarkerVisualState } from './markerVisualState';
import { createEndpointPopup, createPausePopup, createWaypointPopup } from './popups';
import type {
  CheckpointData,
  CheckpointDataRef,
  MarkerRegistryEntry,
  OpenCheckpointMarker,
} from './types';

export type { OpenCheckpointMarker } from './types';

interface UseItineraryCheckpointMarkersArgs {
  itineraries: ItineraryProject['itineraries'];
  map: MapboxMap | null;
  isMapLoaded: boolean;
  routesEnabled?: boolean;
  pausesEnabled?: boolean;
  waypointsEnabled?: boolean;
  poisRouteEnabled?: boolean;
  favorisEnabled?: boolean;
  selectedPoiCategories?: Set<string>;
  onChangePauseDuration?: (id: string, durationMin: number) => void;
  onDeletePause?: (id: string) => void;
  onTogglePauseFavorite?: (id: string, favorite: boolean) => void;
  onDeleteWaypoint?: (id: string) => void;
  onToggleWaypointFavorite?: (id: string, favorite: boolean) => void;
  onMoveWaypoint?: (id: string, lat: number, lon: number) => void;
}

/**
 * Marqueurs de checkpoint (départ, arrivée, pauses, waypoints) des itinéraires
 * visibles, avec leurs popups ; synchronisés en place sur chaque changement.
 */
export function useItineraryCheckpointMarkers({
  itineraries,
  map,
  isMapLoaded,
  routesEnabled = true,
  pausesEnabled = true,
  waypointsEnabled = true,
  poisRouteEnabled = true,
  favorisEnabled = true,
  selectedPoiCategories,
  onChangePauseDuration,
  onDeletePause,
  onTogglePauseFavorite,
  onDeleteWaypoint,
  onToggleWaypointFavorite,
  onMoveWaypoint,
}: UseItineraryCheckpointMarkersArgs): {
  openCheckpointMarker: OpenCheckpointMarker;
} {
  const registryRef = useRef<Map<string, MarkerRegistryEntry>>(new Map());

  // Keep latest callbacks in ref for stable popup handlers
  const callbacksRef = useRef({
    onChangePauseDuration,
    onDeletePause,
    onTogglePauseFavorite,
    onDeleteWaypoint,
    onToggleWaypointFavorite,
    onMoveWaypoint,
  });

  useEffect(() => {
    callbacksRef.current = {
      onChangePauseDuration,
      onDeletePause,
      onTogglePauseFavorite,
      onDeleteWaypoint,
      onToggleWaypointFavorite,
      onMoveWaypoint,
    };
  }, [
    onChangePauseDuration,
    onDeletePause,
    onTogglePauseFavorite,
    onDeleteWaypoint,
    onToggleWaypointFavorite,
    onMoveWaypoint,
  ]);

  useEffect(() => {
    const registry = registryRef.current;
    if (!map || !isMapLoaded || !routesEnabled) {
      registry.forEach((entry) => entry.marker.remove());
      registry.clear();
      return;
    }

    const currentZoom = map.getZoom();
    const currentCheckpoints: CheckpointData[] = [];

    for (const itinerary of itineraries) {
      if (itinerary.visible === false) continue;
      currentCheckpoints.push(
        ...collectItineraryCheckpoints(itinerary, { pausesEnabled, waypointsEnabled, favorisEnabled }),
      );
    }

    const currentKeys = new Set(currentCheckpoints.map((cp) => cp.key));

    // Remove deleted / inactive markers
    for (const [key, entry] of registry.entries()) {
      if (!currentKeys.has(key)) {
        entry.marker.remove();
        registry.delete(key);
      }
    }

    // Add or update markers
    for (const cp of currentCheckpoints) {
      const existing = registry.get(cp.key);
      if (existing) {
        if (existing.signature !== cp.signature) {
          existing.marker.setLngLat(cp.coord);
          existing.signature = cp.signature;
          existing.dataRef.current = cp;
          existing.syncPopup?.();
          updateMarkerElement(existing.element, cp);
        }
        applyMarkerVisualState(existing, currentZoom);
      } else {
        const element = createMarkerElement(cp.kind, cp.label, cp.durationMin, cp.distanceKm, cp.favorite);
        applyTracePointDataset(element, cp);
        const dataRef: CheckpointDataRef = { current: cp };
        const popupHandle =
          cp.kind === 'pause' && cp.pauseId
            ? createPausePopup(dataRef, {
                onChangeDuration: (id, dur) => callbacksRef.current.onChangePauseDuration?.(id, dur),
                onDelete: (id) => callbacksRef.current.onDeletePause?.(id),
                onToggleFavorite: (id, fav) => callbacksRef.current.onTogglePauseFavorite?.(id, fav),
              })
            : cp.kind === 'waypoint' && cp.waypointId
              ? createWaypointPopup(dataRef, {
                  onDelete: (id) => callbacksRef.current.onDeleteWaypoint?.(id),
                  onToggleFavorite: (id, fav) => callbacksRef.current.onToggleWaypointFavorite?.(id, fav),
                })
              : cp.kind === 'start' || cp.kind === 'end'
                ? createEndpointPopup(dataRef)
                : undefined;
        const popup = popupHandle?.popup;

        const marker = new mapboxgl.Marker({
          element,
          anchor: cp.kind === 'waypoint' ? 'center' : 'bottom',
          pitchAlignment: 'viewport',
          rotationAlignment: 'viewport',
          occludedOpacity: 0,
          draggable: cp.kind === 'waypoint',
        })
          .setLngLat(cp.coord);

        if (cp.kind === 'waypoint' && cp.waypointId) {
          marker.on('dragend', () => {
            const wpId = dataRef.current.waypointId;
            if (!wpId) return;
            const lngLat = marker.getLngLat();
            callbacksRef.current.onMoveWaypoint?.(wpId, lngLat.lat, lngLat.lng);
          });
        }

        if (popup) {
          marker.setPopup(popup);
          keepPopupInVisibleMap(popup, map);
          closeMarkerPopupOnSecondClick(element, popup);
        }

        marker.addTo(map);

        const entry: MarkerRegistryEntry = {
          marker,
          popup,
          syncPopup: popupHandle?.sync,
          dataRef,
          signature: cp.signature,
          element,
          kind: cp.kind,
        };

        registry.set(cp.key, entry);
        applyMarkerVisualState(entry, currentZoom);
      }
    }
  }, [itineraries, isMapLoaded, map, pausesEnabled, routesEnabled, waypointsEnabled, poisRouteEnabled, favorisEnabled, selectedPoiCategories]);

  // Handle map zoom changes in real-time
  useEffect(() => {
    if (!map) return;

    // rAF-coalesced: `zoom` fires several times per frame during wheel zooms.
    let frameId: number | null = null;
    const handleZoom = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const currentZoom = map.getZoom();
        registryRef.current.forEach((entry) => {
          applyMarkerVisualState(entry, currentZoom);
        });
      });
    };

    map.on('zoom', handleZoom);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      map.off('zoom', handleZoom);
    };
  }, [map]);

  // Re-anchor on terrain idle (identical to classic POIs)
  useEffect(() => {
    if (!map) return;

    const handleIdle = () => {
      registryRef.current.forEach((entry) => {
        entry.marker.setLngLat(entry.marker.getLngLat());
      });
    };

    map.on('idle', handleIdle);
    return () => {
      map.off('idle', handleIdle);
    };
  }, [map]);

  // Clean up on unmount
  useEffect(() => {
    const registry = registryRef.current;
    return () => {
      registry.forEach((entry) => entry.marker.remove());
      registry.clear();
    };
  }, []);

  const openCheckpointMarker = useCallback<OpenCheckpointMarker>(
    (checkpointId, coords, scope) => {
      const targetEntry = findCheckpointMarkerEntry(registryRef.current, checkpointId, coords, scope);
      if (!targetEntry) return false;

      for (const other of registryRef.current.values()) {
        if (other !== targetEntry && other.popup?.isOpen()) {
          other.popup.remove();
        }
      }

      // Sélection depuis la feuille de route / le graphique : on ouvre, on ne
      // referme jamais un panneau déjà ouvert.
      if (targetEntry.popup) {
        if (!targetEntry.popup.isOpen()) targetEntry.marker.togglePopup();
      } else {
        targetEntry.element.click();
      }

      if (map) {
        const lngLat = targetEntry.marker.getLngLat();
        flyToPoi(map, { lon: lngLat.lng, lat: lngLat.lat });
      }

      return true;
    },
    [map],
  );

  return { openCheckpointMarker };
}
