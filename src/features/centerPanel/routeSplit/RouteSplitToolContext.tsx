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
import { translateAppText } from '@/shared/i18n';
import { useRouteHoverPreview } from '../hooks/useRouteHoverPreview';
import { findSplitIndexForMapClick } from './routeSnap';

const SPLIT_CURSOR = 'url("/svgv2/icone/scissors.svg") 4 4, crosshair';

interface RouteSplitToolContextValue {
  armed: boolean;
  canSplit: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
  splitAtPointIndex: (splitIndex: number) => boolean;
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

  // Hover-preview marker: snaps to the nearest route vertex while armed, dims
  // when the cursor is outside the click tolerance.
  useRouteHoverPreview({
    map,
    armed: armed && canSplit,
    color: activeItinerary?.color,
    snapRoutePoints: routePoints,
  });

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
  }, []);

  const splitAtPointIndex = useCallback(
    (splitIndex: number) => {
      if (!store || !activeItinerary || !routePoints || routePoints.length < 4) return false;

      const result = store.splitItineraryAtPointIndex(activeItinerary.id, splitIndex);
      if (!result) return false;

      setArmed(false);
      setStatusMessage(translateAppText('Trace découpée: {{name}}', { name: result.createdItineraryName }));
      return true;
    },
    [activeItinerary, routePoints, store],
  );

  const toggle = useCallback(() => {
    if (!canSplit) return;
    setArmed((current) => {
      const next = !current;
      setStatusMessage(next ? translateAppText('Cliquez sur la trace pour la découper') : null);
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

      if (!splitAtPointIndex(splitIndex)) return;

      canvas.style.cursor = '';
    };

    const handleContextMenu = (event: MapMouseEvent) => {
      event.preventDefault();
      deactivate();
    };

    applyCursor();
    map.on('mousemove', applyCursor);
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);

    return () => {
      map.off('mousemove', applyCursor);
      map.off('click', handleClick);
      map.off('contextmenu', handleContextMenu);
      canvas.style.cursor = '';
    };
  }, [activeItinerary, armed, deactivate, map, routePoints, splitAtPointIndex, store]);

  const value = useMemo<RouteSplitToolContextValue>(
    () => ({
      armed,
      canSplit,
      statusMessage,
      toggle,
      deactivate,
      splitAtPointIndex,
    }),
    [armed, canSplit, deactivate, splitAtPointIndex, statusMessage, toggle],
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