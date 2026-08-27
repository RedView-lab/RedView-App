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
  onLidarRouteRename?: (routeId: string, name: string) => void;
  onLidarRouteDelete?: (routeId: string) => void;
}

/**
 * Hook gérant la synchronisation temps réel des traces GPX entre
 * l'application principale RedView et le Viewer LiDAR HD (inter-onglets / BroadcastChannel).
 */
export function useLidarRouteSync({
  itineraries,
  onLidarRouteEdit,
  onLidarRouteCreate,
  onLidarRouteRename,
  onLidarRouteDelete,
}: UseLidarRouteSyncOptions): void {
  const onLidarRouteEditRef = useRef(onLidarRouteEdit);
  onLidarRouteEditRef.current = onLidarRouteEdit;

  const onLidarRouteCreateRef = useRef(onLidarRouteCreate);
  onLidarRouteCreateRef.current = onLidarRouteCreate;

  const onLidarRouteRenameRef = useRef(onLidarRouteRename);
  onLidarRouteRenameRef.current = onLidarRouteRename;

  const onLidarRouteDeleteRef = useRef(onLidarRouteDelete);
  onLidarRouteDeleteRef.current = onLidarRouteDelete;

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
          onLidarRouteEditRef.current?.(msg.routeId, msg.points, msg.actionName);
        } else if (msg.type === 'CREATE_ROUTE') {
          onLidarRouteCreateRef.current?.(msg.route);
        } else if (msg.type === 'RENAME_ROUTE') {
          onLidarRouteRenameRef.current?.(msg.routeId, msg.name);
        } else if (msg.type === 'DELETE_ROUTE') {
          onLidarRouteDeleteRef.current?.(msg.routeId);
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);
}
