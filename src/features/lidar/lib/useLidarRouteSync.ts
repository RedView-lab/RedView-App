import { useEffect, useRef } from 'react';
import {
  subscribeToLidarRouteOverlay,
  syncLidarRouteOverlay,
  type LidarRouteOverlayItem,
  type LidarRouteSyncMessage,
} from './routeOverlaySync';
import type { Itinerary } from '@/features/itineraryPanel/types';

interface UseLidarRouteSyncOptions {
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
  itineraries,
  ...handlers
}: UseLidarRouteSyncOptions): void {
  // Latest handlers, read by the long-lived channel subscription below.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  // 1) Outbound sync: When itineraries change in RedView, push to LiDAR overlay
  useEffect(() => {
    if (itineraries) {
      syncLidarRouteOverlay(itineraries, 'redview_app');
    }
  }, [itineraries]);

  // 2) Inbound sync: Listen to edits from LiDAR viewer
  useEffect(() => {
    const unsubscribe = subscribeToLidarRouteOverlay((msg: LidarRouteSyncMessage) => {
      if ('type' in msg) {
        if (msg.source !== 'lidar_viewer') return;

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
