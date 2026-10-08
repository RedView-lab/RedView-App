import { useCallback, useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import { flyToPoi } from '@/features/map3d/lib/cameraFlight';
import { keepPopupInVisibleMap } from '@/features/map3d/lib/mapPopupSafeArea';
import { closeMarkerPopupOnSecondClick } from '@/features/map3d/lib/pointPanelDismiss';
import { registerTracePointControls } from '../../lib/tracer/tracePointDataset';
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
}: UseItineraryCheckpointMarkersArgs): {
  openCheckpointMarker: OpenCheckpointMarker;
} {
  const registryRef = useRef<Map<string, MarkerRegistryEntry>>(new Map());

  // Garder les derniers rappels dans une ref pour des gestionnaires de popup stables
  const callbacksRef = useRef({
    onChangePauseDuration,
    onDeletePause,
    onTogglePauseFavorite,
    onDeleteWaypoint,
    onToggleWaypointFavorite,
  });

  useEffect(() => {
    callbacksRef.current = {
      onChangePauseDuration,
      onDeletePause,
      onTogglePauseFavorite,
      onDeleteWaypoint,
      onToggleWaypointFavorite,
    };
  }, [
    onChangePauseDuration,
    onDeletePause,
    onTogglePauseFavorite,
    onDeleteWaypoint,
    onToggleWaypointFavorite,
  ]);

  const closeOtherPopups = useCallback((target: MarkerRegistryEntry) => {
    for (const other of registryRef.current.values()) {
      if (other !== target && other.popup?.isOpen()) {
        other.popup.remove();
      }
    }
  }, []);

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

    // Retirer les marqueurs supprimés / inactifs
    for (const [key, entry] of registry.entries()) {
      if (!currentKeys.has(key)) {
        entry.marker.remove();
        registry.delete(key);
      }
    }

    // Ajouter ou mettre à jour les marqueurs
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
                ? createEndpointPopup(dataRef, {
                    onDelete: (rowId) => callbacksRef.current.onDeleteWaypoint?.(rowId),
                  })
                : undefined;
        const popup = popupHandle?.popup;

        // Jamais `draggable` : départ, arrivée et étapes se déplacent par le
        // geste de l'outil de tracé (useTracePointDrag), avec ou sans outil armé.
        const marker = new mapboxgl.Marker({
          element,
          anchor: cp.kind === 'waypoint' ? 'center' : 'bottom',
          pitchAlignment: 'viewport',
          rotationAlignment: 'viewport',
          occludedOpacity: 0,
        })
          .setLngLat(cp.coord);

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

        if (cp.kind !== 'pause') {
          registerTracePointControls(element, {
            togglePanel: () => {
              if (!popup) return;
              if (popup.isOpen()) {
                popup.remove();
                return;
              }
              closeOtherPopups(entry);
              // Le clic du geste est absorbé : on ferme les autres popups
              // `closeOnClick` (POI…) comme l'aurait fait le clic de carte.
              map.fire('preclick');
              marker.togglePopup();
            },
            anchorPoint: () => {
              const point = map.project(marker.getLngLat());
              return { x: point.x, y: point.y };
            },
            preview: (position) => {
              marker.setLngLat(position ? [position.lon, position.lat] : dataRef.current.coord);
            },
          });
        }

        registry.set(cp.key, entry);
        applyMarkerVisualState(entry, currentZoom);
      }
    }
  }, [itineraries, isMapLoaded, map, pausesEnabled, routesEnabled, waypointsEnabled, poisRouteEnabled, favorisEnabled, selectedPoiCategories, closeOtherPopups]);

  // Suivre les changements de zoom de la carte en temps réel
  useEffect(() => {
    if (!map) return;

    // Regroupé par rAF : `zoom` se déclenche plusieurs fois par image pendant un zoom à la molette.
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

  // Réancrer au repos du terrain (comme les POI classiques)
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

      closeOtherPopups(targetEntry);

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
    [closeOtherPopups, map],
  );

  return { openCheckpointMarker };
}
