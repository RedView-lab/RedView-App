import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';
import {
  buildPendingRoutePatchForEditedRow,
  insertWaypointAtRoutePosition,
} from '@/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations';
import { addItineraryVariantInPlace } from '@/features/itineraryPanel/lib/project';
import { reverseGeocodeSettlement } from '@/features/itineraryPanel/lib/geocoding';
import { translateAppText } from '@/shared/i18n';
import { useRouteSplitToolOptional } from '../routeSplit';
import { useTraceToolOptional } from '../tracer';
import { useRouteMergeToolOptional } from '../routeMerge';
import { useForbiddenZoneToolOptional } from '../forbiddenZones';
import {
  createRouteEditPointer,
  type RouteEditPoint,
  type RouteEditPointerController,
} from './routeEditPointer';

interface RouteDragWaypointContextValue {
  /** True while a route point is actively being dragged. */
  dragging: boolean;
}

const RouteDragWaypointContext = createContext<RouteDragWaypointContextValue | null>(null);

interface RouteDragWaypointProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

/** Rayon du point d'aperçu, proportionné à l'épaisseur du tracé. */
function getPreviewRadius(traceWidthPx: number): number {
  return Math.max(5.5, Math.min(10, traceWidthPx / 2 + 2.5));
}

/**
 * Saisie de la trace active en mode Tracer : cliquer dessus insère un point de
 * passage, la glisser en dépose un là où on relâche. Toute la logique pointeur
 * (survol, curseur, clic, drag) vit dans `routeEditPointer` ; ce provider ne
 * fait que l'armer et appliquer les insertions au projet.
 */
export function RouteDragWaypointProvider({ children, map }: RouteDragWaypointProviderProps) {
  const store = useProjectStoreOptional();
  const splitTool = useRouteSplitToolOptional();
  const traceTool = useTraceToolOptional();
  const mergeTool = useRouteMergeToolOptional();
  const forbiddenZoneTool = useForbiddenZoneToolOptional();

  const otherBlockingToolArmed = Boolean(
    splitTool?.armed || forbiddenZoneTool?.armed || mergeTool?.armed,
  );
  // Actif pendant tout le mode Tracer, trace présente ou non : le contrôleur
  // n'est pas recréé à chaque recalcul de la trace (pas de remise à zéro du
  // curseur au milieu d'un survol).
  const active = Boolean(map) && Boolean(traceTool?.armed) && !otherBlockingToolArmed;

  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const routePoints = activeItinerary?.gpxRoute?.points ?? null;

  const [isDragging, setIsDragging] = useState(false);

  const storeRef = useRef(store);
  const activeItineraryIdRef = useRef(activeItinerary?.id);
  const routePointsRef = useRef(routePoints);
  const routeColorRef = useRef(activeItinerary?.color);
  const routeTraceWidthRef = useRef(store?.project.controlPanel?.routes?.traceWidthPx ?? 8);

  useEffect(() => {
    storeRef.current = store;
    activeItineraryIdRef.current = activeItinerary?.id;
    routePointsRef.current = routePoints;
    routeColorRef.current = activeItinerary?.color;
    routeTraceWidthRef.current = store?.project.controlPanel?.routes?.traceWidthPx ?? 8;
  });

  const commitWaypoint = useCallback(
    (anchor: RouteEditPoint, drop: RouteEditPoint, asVariant: boolean) => {
      const currentStore = storeRef.current;
      const itineraryId = activeItineraryIdRef.current;
      if (!currentStore || !itineraryId) return;

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
            targetItinerary.timeline,
            result.newRowId,
          );
          targetItinerary.prediction = null;
        } else {
          delete targetItinerary.pendingRoutePatch;
        }
        delete targetItinerary.pendingTraceExtension;
        delete targetItinerary.routeAudit;
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
          /* keep default fallback label */
        });
    },
    [],
  );

  const controllerRef = useRef<RouteEditPointerController | null>(null);

  useEffect(() => {
    if (!active || !map) return;

    const controller = createRouteEditPointer(map, {
      getRoutePoints: () => routePointsRef.current,
      getPreviewStyle: () => ({
        color: routeColorRef.current,
        radius: getPreviewRadius(routeTraceWidthRef.current),
      }),
      onCommit: commitWaypoint,
      onDraggingChange: setIsDragging,
    });
    controllerRef.current = controller;

    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, [active, commitWaypoint, map]);

  // Trace recalculée sous un pointeur immobile : on réévalue le survol.
  useEffect(() => {
    controllerRef.current?.refresh();
  }, [routePoints]);

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

export function useRouteDragWaypointOptional(): RouteDragWaypointContextValue | null {
  return useContext(RouteDragWaypointContext);
}
