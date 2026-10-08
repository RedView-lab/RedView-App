import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import { insertWaypointAtRoutePosition } from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations';
import { buildPendingRoutePatchForEditedRow } from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineRoutePatch';
import { addItineraryVariantInPlace } from '@/features/itineraryPanel/lib/project';
import { reverseGeocodeSettlement } from '@/features/itineraryPanel/lib/geocoding';
import { DEFAULT_ROUTE_TRACE_WIDTH_PX } from '@/features/itineraryPanel/lib/route-layer/constants';
import { translateAppText } from '@/shared/i18n';
import { useCommentToolOptional } from '@/features/comments/context/commentTool';
import { useRouteSplitToolOptional } from '../routeSplit';
import { useTracePointDrag, useTraceToolOptional } from '../tracer';
import { useRouteMergeToolOptional } from '../routeMerge';
import { useForbiddenZoneToolOptional } from '../forbiddenZones';
import {
  createRouteEditPointer,
  type RouteEditPoint,
  type RouteEditPointerController,
  type RouteEditTarget,
} from './routeEditPointer';
import { RouteDragWaypointContext, type RouteDragWaypointContextValue } from './useRouteDragWaypoint';

interface RouteDragWaypointProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

/** Rayon du point d'aperçu, proportionné à l'épaisseur du tracé. */
function getPreviewRadius(traceWidthPx: number): number {
  return Math.max(5.5, Math.min(10, traceWidthPx / 2 + 2.5));
}

/**
 * Gestes d'édition du tracé sur la carte :
 *   - en mode Tracer, saisie de la trace de n'importe quel itinéraire visible :
 *     la glisser dépose un point de passage là où on relâche (et sélectionne
 *     l'itinéraire) ; un clic insère un point sur la trace sélectionnée, et ne
 *     fait que sélectionner une autre trace. Toute la logique pointeur
 *     (survol, curseur, clic, drag) vit dans `routeEditPointer` ;
 *   - avec ou sans Tracer, clic / glisser des points eux-mêmes (départ,
 *     arrivée, étapes : `useTracePointDrag`), sauf quand un autre outil
 *     consomme les clics de la carte.
 */
export function RouteDragWaypointProvider({ children, map }: RouteDragWaypointProviderProps) {
  const store = useProjectStoreOptional();
  const splitTool = useRouteSplitToolOptional();
  const traceTool = useTraceToolOptional();
  const mergeTool = useRouteMergeToolOptional();
  const forbiddenZoneTool = useForbiddenZoneToolOptional();
  const commentTool = useCommentToolOptional();

  const otherBlockingToolArmed = Boolean(
    splitTool?.armed || forbiddenZoneTool?.armed || mergeTool?.armed,
  );

  const commitPointDrag = traceTool?.commitPointDrag;
  useTracePointDrag({
    map,
    enabled: Boolean(map && commitPointDrag) && !otherBlockingToolArmed && !commentTool?.armed,
    onCommit: (commit) => commitPointDrag?.(commit) ?? false,
    onDraggingChange: traceTool?.onPointDraggingChange,
  });
  // Actif pendant tout le mode Tracer, trace présente ou non : le contrôleur
  // n'est pas recréé à chaque recalcul de la trace (pas de remise à zéro du
  // curseur au milieu d'un survol).
  const active = Boolean(map) && Boolean(traceTool?.armed) && !otherBlockingToolArmed;

  const itineraries = store?.project.itineraries;
  const activeItineraryId = store?.project.activeItineraryId;
  // Traces saisissables, la sélectionnée en premier (prioritaire là où elles
  // se superposent).
  const routes = useMemo<RouteEditTarget[]>(() => {
    const out: RouteEditTarget[] = [];
    for (const itinerary of itineraries ?? []) {
      const points = itinerary.gpxRoute?.points;
      if (itinerary.visible === false || !points || points.length < 2) continue;
      const target = { id: itinerary.id, points, color: itinerary.color };
      if (itinerary.id === activeItineraryId) out.unshift(target);
      else out.push(target);
    }
    return out;
  }, [activeItineraryId, itineraries]);

  const [isDragging, setIsDragging] = useState(false);

  const storeRef = useRef(store);
  const routesRef = useRef(routes);
  const routeTraceWidthRef = useRef(store?.project.controlPanel?.routes?.traceWidthPx ?? DEFAULT_ROUTE_TRACE_WIDTH_PX);

  useEffect(() => {
    storeRef.current = store;
    routesRef.current = routes;
    routeTraceWidthRef.current = store?.project.controlPanel?.routes?.traceWidthPx ?? DEFAULT_ROUTE_TRACE_WIDTH_PX;
  });

  const commitWaypoint = useCallback(
    (
      itineraryId: string,
      anchor: RouteEditPoint,
      drop: RouteEditPoint,
      { asVariant, dragged }: { asVariant: boolean; dragged: boolean },
    ) => {
      const currentStore = storeRef.current;
      if (!currentStore) return;
      if (!dragged && itineraryId !== currentStore.project.activeItineraryId) {
        // Clic sur la trace d'un autre itinéraire : on le sélectionne seulement.
        currentStore.setProject((project) => (
          project.activeItineraryId === itineraryId ? project : { ...project, activeItineraryId: itineraryId }
        ));
        return;
      }

      const variantBox: { current: { createdItineraryId: string; createdItineraryName: string } | null } = {
        current: null,
      };

      const committed = currentStore.commitTraceMutation(itineraryId, (draft) => {
        let targetItinerary = draft.itineraries.find((it) => it.id === itineraryId);
        if (!targetItinerary) return false;
        if (asVariant) {
          const created = addItineraryVariantInPlace(draft, itineraryId);
          if (!created) return false;
          const forked = draft.itineraries.find((it) => it.id === created.createdItineraryId);
          if (!forked) return false;
          variantBox.current = created;
          targetItinerary = forked;
        }

        const currentRoute = targetItinerary.gpxRoute;
        if (!currentRoute?.points || currentRoute.points.length < 2) {
          return false;
        }

        const result = insertWaypointAtRoutePosition(
          targetItinerary.timeline,
          currentRoute.points,
          anchor,
          drop,
        );
        if (!result) return false;

        if (!result.isDirectOnRoute) {
          targetItinerary.pendingRoutePatch = buildPendingRoutePatchForEditedRow(
            targetItinerary,
            result.newRowId,
            result.anchorDistanceM,
          );
          targetItinerary.prediction = null;
        } else {
          delete targetItinerary.pendingRoutePatch;
        }
        delete targetItinerary.pendingTraceExtension;
        delete targetItinerary.routeAudit;
        // L'itinéraire édité devient le sélectionné (dessiné au-dessus, panneau).
        draft.activeItineraryId = targetItinerary.id;
        return true;
      });

      if (!committed) return;

      // Nom de lieu du nouveau point, résolu en arrière-plan.
      const targetItineraryId = variantBox.current?.createdItineraryId ?? itineraryId;
      void reverseGeocodeSettlement(drop.lon, drop.lat, { maxDistanceMeters: 1000 })
        .then((settlement) => {
          const name = settlement?.name?.trim();
          if (!name) return;
          currentStore.updateItineraryWithoutHistory(targetItineraryId, (it) => {
            const newlyAdded = it.timeline.find(
              (row) =>
                row.kind === 'waypoint' &&
                row.lat === drop.lat &&
                row.lon === drop.lon &&
                (row.label === translateAppText('Nouveau point') || row.label === 'Nouveau point'),
            );
            if (newlyAdded) {
              newlyAdded.label = name;
            }
          });
        })
        .catch(() => {
          /* garder le libellé de repli par défaut */
        });
    },
    [],
  );

  const controllerRef = useRef<RouteEditPointerController | null>(null);

  useEffect(() => {
    if (!active || !map) return;

    const controller = createRouteEditPointer(map, {
      getRoutes: () => routesRef.current,
      getPreviewRadius: () => getPreviewRadius(routeTraceWidthRef.current),
      onCommit: commitWaypoint,
      onDraggingChange: setIsDragging,
    });
    controllerRef.current = controller;

    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, [active, commitWaypoint, map]);

  // Traces recalculées sous un pointeur immobile : on réévalue le survol.
  useEffect(() => {
    controllerRef.current?.refresh();
  }, [routes]);

  const value = useMemo<RouteDragWaypointContextValue>(
    () => ({ dragging: isDragging }),
    [isDragging],
  );

  return (
    <RouteDragWaypointContext.Provider value={value}>
      {children}
    </RouteDragWaypointContext.Provider>
  );
}
