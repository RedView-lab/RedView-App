import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';
import { queryPoiAtPoint } from '@/features/poi/lib/poi-markers';

import { useProjectStoreOptional } from '@/features/itineraryPanel/context/ProjectStore/hooks';
import { translateAppText } from '@/shared/i18n';
import { useEscapeToExit } from '@/shared/hooks/useEscapeToExit';
import { useHasChanged } from '@/shared/hooks/useHasChanged';
import { useRouteHoverPreview } from '../../hooks/useRouteHoverPreview';
import { findSplitIndexForMapClick } from './routeSnap';
import {
  handlePointPanelMousedown,
  shouldIgnoreMapClickAfterPanelDismiss,
} from '@/features/map3d/lib/pointPanelDismiss';
import { RouteSplitToolContext, type RouteSplitToolContextValue } from './useRouteSplitTool';

const SPLIT_CURSOR = 'url("/icons/ui/scissors.svg") 4 4, crosshair';

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

  // Marqueur d'aperçu au survol : s'accroche au sommet du tracé le plus proche
  // tant que l'outil est armé, s'atténue quand le curseur est hors de la tolérance de clic.
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

  // Plus de tracé découpable (itinéraire changé, points retirés) : l'outil se
  // désarme et le reste, même si le tracé redevient découpable.
  const canSplitChanged = useHasChanged(canSplit);
  if (canSplitChanged && !canSplit && armed) setArmed(false);

  useEscapeToExit(armed, deactivate);

  useEffect(() => {
    if (!armed || !map || !store || !activeItinerary || !routePoints || routePoints.length < 4) {
      return;
    }

    const canvas = map.getCanvas();
    const applyCursor = () => {
      canvas.style.cursor = SPLIT_CURSOR;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 0) {
        handlePointPanelMousedown(event.target);
      }
    };

    const handleClick = (event: MapMouseEvent) => {
      const originalTarget = event.originalEvent?.target as HTMLElement | null;
      if (
        (originalTarget &&
          originalTarget.closest(
            '.mapboxgl-popup, .rv-poi-draft-card, [data-rv-poi-draft-card], .rv-poi-marker, .rv-checkpoint-marker, button, a, [role="button"]',
          )) ||
        shouldIgnoreMapClickAfterPanelDismiss(originalTarget) ||
        queryPoiAtPoint(map, event.point)
      ) {
        return;
      }

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
    canvas.addEventListener('mousedown', handleMouseDown, true);
    map.on('mousemove', applyCursor);
    map.on('click', handleClick);
    map.on('contextmenu', handleContextMenu);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown, true);
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
