import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import { useProjectStoreOptional } from '@/features/itineraryPanel';

const SPLIT_CURSOR = 'url("/svgv2/icone/scissors.svg") 4 4, crosshair';
const MAX_ROUTE_CLICK_DISTANCE_PX = 12;

interface RouteSplitToolContextValue {
  armed: boolean;
  canSplit: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
}

const RouteSplitToolContext = createContext<RouteSplitToolContextValue | null>(null);

interface RouteSplitToolProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

export function RouteSplitToolProvider({ children, map }: RouteSplitToolProviderProps) {
  const store = useProjectStoreOptional();
  const [armed, setArmed] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const routePoints = activeItinerary?.gpxRoute?.points ?? null;
  const canSplit = (routePoints?.length ?? 0) >= 4;

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
  }, []);

  const toggle = useCallback(() => {
    if (!canSplit) return;
    setArmed((current) => {
      const next = !current;
      setStatusMessage(next ? 'Cliquez sur la trace pour la découper' : null);
      return next;
    });
  }, [canSplit]);

  useEffect(() => {
    if (canSplit) return;
    setArmed(false);
  }, [canSplit]);

  useEffect(() => {
    if (!armed || !map || !store || !activeItinerary || !routePoints || routePoints.length < 4) {
      return;
    }

    const canvas = map.getCanvas();
    const applyCursor = () => {
      canvas.style.cursor = SPLIT_CURSOR;
    };

    const handleClick = (event: MapMouseEvent) => {
      const splitIndex = findSplitIndexForMapClick(map, routePoints, event.point.x, event.point.y);
      if (splitIndex == null) return;

      const result = store.splitItineraryAtPointIndex(activeItinerary.id, splitIndex);
      if (!result) return;

      setArmed(false);
      setStatusMessage(`Trace découpée: ${result.createdItineraryName}`);
    };

    applyCursor();
    map.on('mousemove', applyCursor);
    map.on('click', handleClick);

    return () => {
      map.off('mousemove', applyCursor);
      map.off('click', handleClick);
      if (canvas.style.cursor === SPLIT_CURSOR) {
        canvas.style.cursor = '';
      }
    };
  }, [activeItinerary, armed, map, routePoints, store]);

  const value = useMemo<RouteSplitToolContextValue>(
    () => ({
      armed,
      canSplit,
      statusMessage,
      toggle,
      deactivate,
    }),
    [armed, canSplit, deactivate, statusMessage, toggle],
  );

  return (
    <RouteSplitToolContext.Provider value={value}>
      {children}
    </RouteSplitToolContext.Provider>
  );
}

export function useRouteSplitToolOptional(): RouteSplitToolContextValue | null {
  return useContext(RouteSplitToolContext);
}

function findSplitIndexForMapClick(
  map: MapboxMap,
  points: Array<{ lat: number; lon: number }>,
  clickX: number,
  clickY: number,
): number | null {
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  let bestIndex: number | null = null;

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = map.project([points[index].lon, points[index].lat]);
    const end = map.project([points[index + 1].lon, points[index + 1].lat]);
    const projection = projectPointToSegment(clickX, clickY, start.x, start.y, end.x, end.y);
    if (projection.distanceSq >= bestDistanceSq) continue;
    bestDistanceSq = projection.distanceSq;
    bestIndex = projection.t <= 0.5 ? index : index + 1;
  }

  if (bestIndex == null) return null;
  if (bestDistanceSq > MAX_ROUTE_CLICK_DISTANCE_PX * MAX_ROUTE_CLICK_DISTANCE_PX) return null;
  return Math.max(1, Math.min(bestIndex, points.length - 2));
}

function projectPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distanceSq: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const segmentLengthSq = dx * dx + dy * dy;
  if (segmentLengthSq <= 1e-6) {
    return {
      distanceSq: (px - ax) * (px - ax) + (py - ay) * (py - ay),
      t: 0,
    };
  }

  const rawT = ((px - ax) * dx + (py - ay) * dy) / segmentLengthSq;
  const t = Math.max(0, Math.min(1, rawT));
  const projectedX = ax + dx * t;
  const projectedY = ay + dy * t;
  return {
    distanceSq: (px - projectedX) * (px - projectedX) + (py - projectedY) * (py - projectedY),
    t,
  };
}