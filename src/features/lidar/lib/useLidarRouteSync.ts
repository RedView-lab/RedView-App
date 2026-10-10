import { useEffect, useRef } from 'react';
import {
  claimLidarRouteTaker,
  isLidarRouteTaker,
  setLidarRouteSyncProject,
  subscribeToLidarRouteOverlay,
  syncLidarRouteOverlay,
  type LidarRouteOverlayItem,
  type LidarRouteSyncMessage,
} from './routeOverlaySync';
import type { Itinerary } from '@/features/itineraryPanel/types';

interface UseLidarRouteSyncOptions {
  /** Projet ouvert dans cet onglet : seuls ses messages sont traités, les siens le portent (C2-1). */
  projectId: string | null;
  itineraries: readonly Itinerary[] | undefined;
  onLidarRouteEdit?: (
    routeId: string,
    points: Array<{ lat: number; lon: number; elevationM?: number | null; distanceM?: number }>,
    actionName?: string,
  ) => void;
  onLidarRouteCreate?: (route: LidarRouteOverlayItem) => void;
  onLidarRouteDuplicate?: (sourceRouteId: string, route: LidarRouteOverlayItem) => void;
  onLidarRouteRename?: (routeId: string, name: string) => void;
  onLidarRouteDelete?: (routeId: string) => void;
}

/**
 * Hook gérant la synchronisation temps réel des traces GPX entre
 * l'application principale RedView et le Viewer LiDAR HD (inter-onglets / BroadcastChannel).
 */
export function useLidarRouteSync({
  projectId,
  itineraries,
  ...handlers
}: UseLidarRouteSyncOptions): void {
  // Derniers gestionnaires, lus par l'abonnement au canal ci-dessous, qui dure.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  // 0) Projet de la page (déclaré avant les publications ci-dessous, qui le portent).
  useEffect(() => {
    setLidarRouteSyncProject(projectId);
    // Un seul onglet par projet applique les messages du visualiseur (C2-1).
    const releaseTaker = projectId ? claimLidarRouteTaker(projectId) : null;
    return () => {
      releaseTaker?.();
      setLidarRouteSyncProject(null);
    };
  }, [projectId]);

  // 1) Synchro sortante : quand les itinéraires changent dans RedView, pousser vers la couche LiDAR
  // (seulement quand un tracé lui-même a changé : la plupart des éditions du projet n'y touchent pas).
  useEffect(() => {
    if (itineraries) {
      syncLidarRouteOverlay(itineraries, 'redview_app', { onlyIfChanged: true });
    }
  }, [itineraries]);

  // 2) Synchro entrante : écouter les éditions venant du viewer LiDAR
  useEffect(() => {
    const unsubscribe = subscribeToLidarRouteOverlay((msg: LidarRouteSyncMessage) => {
      if ('type' in msg) {
        if (msg.source !== 'lidar_viewer' || !isLidarRouteTaker()) return;

        if (msg.type === 'UPDATE_ROUTE_POINTS') {
          handlersRef.current.onLidarRouteEdit?.(msg.routeId, msg.points, msg.actionName);
        } else if (msg.type === 'CREATE_ROUTE') {
          handlersRef.current.onLidarRouteCreate?.(msg.route);
        } else if (msg.type === 'DUPLICATE_ROUTE') {
          handlersRef.current.onLidarRouteDuplicate?.(msg.sourceRouteId, msg.route);
        } else if (msg.type === 'RENAME_ROUTE') {
          handlersRef.current.onLidarRouteRename?.(msg.routeId, msg.name);
        } else if (msg.type === 'DELETE_ROUTE') {
          handlersRef.current.onLidarRouteDelete?.(msg.routeId);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);
}
