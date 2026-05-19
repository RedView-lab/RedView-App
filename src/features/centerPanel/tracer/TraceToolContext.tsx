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
import {
  formatGpsCoordinateLabel,
  reverseGeocodeSettlement,
} from '@/features/itineraryPanel/lib/geocoding';
import { translateAppText } from '@/shared/i18n';

const TRACE_CURSOR = 'url("/svgv2/icone/edit-04.svg") 3 17, crosshair';

interface TraceToolContextValue {
  armed: boolean;
  canTrace: boolean;
  statusMessage: string | null;
  toggle: () => void;
  deactivate: () => void;
}

const TraceToolContext = createContext<TraceToolContextValue | null>(null);

interface TraceToolProviderProps {
  children: ReactNode;
  map: MapboxMap | null;
}

export function TraceToolProvider({ children, map }: TraceToolProviderProps) {
  const store = useProjectStoreOptional();
  const [armed, setArmed] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const activeItinerary = store?.project.itineraries.find(
    (itinerary) => itinerary.id === store.project.activeItineraryId,
  );
  const startRow = activeItinerary?.timeline.find((row) => row.kind === 'start');
  const endRow = activeItinerary?.timeline.find((row) => row.kind === 'end');
  const hasStartPoint = Boolean(startRow && startRow.lat != null && startRow.lon != null);
  const hasEndPoint = Boolean(endRow && endRow.lat != null && endRow.lon != null);
  const canTrace = Boolean(store && activeItinerary && startRow && endRow);

  const buildTracePrompt = useCallback(() => {
    if (!hasStartPoint) return translateAppText('Cliquez sur la carte pour placer le départ');
    if (!hasEndPoint) return translateAppText('Cliquez sur la carte pour placer l’arrivée');
    return translateAppText('Cliquez sur la carte pour prolonger le tracé');
  }, [hasEndPoint, hasStartPoint]);

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
  }, []);

  const hydratePointLabel = useCallback(
    async (
      itineraryId: string,
      kind: 'start' | 'end',
      lon: number,
      lat: number,
      fallbackLabel: string,
    ) => {
      try {
        const settlement = await reverseGeocodeSettlement(lon, lat, {
          maxDistanceMeters: 1000,
        });
        const resolvedLabel = settlement?.name?.trim() || fallbackLabel;
        store?.updateItinerary(itineraryId, (itinerary) => {
          const currentRow = itinerary.timeline.find((row) => row.kind === kind);
          if (!currentRow || currentRow.lon !== lon || currentRow.lat !== lat) return;
          currentRow.label = resolvedLabel;
        });
      } catch {
        // Keep the GPS fallback label.
      }
    },
    [store],
  );

  const appendPointAt = useCallback(
    (lon: number, lat: number) => {
      if (!store || !activeItinerary) return false;

      const fallbackLabel = formatGpsCoordinateLabel(lon, lat);
      const pointKind: 'start' | 'end' | 'waypoint' = !hasStartPoint
        ? 'start'
        : !hasEndPoint
          ? 'end'
          : 'waypoint';
      const appended = store.appendTracePoint(activeItinerary.id, {
        lat,
        lon,
        label: fallbackLabel,
      });
      if (!appended) return false;

      setStatusMessage(
        pointKind === 'start'
          ? translateAppText('Départ ajouté. Cliquez pour placer l’arrivée')
          : pointKind === 'end'
            ? translateAppText('Arrivée ajoutée. Cliquez pour prolonger le tracé')
            : translateAppText('Point ajouté, recalcul du tracé en cours'),
      );
      if (pointKind !== 'waypoint') {
        void hydratePointLabel(activeItinerary.id, pointKind, lon, lat, fallbackLabel);
      }
      return true;
    },
    [activeItinerary, hasEndPoint, hasStartPoint, hydratePointLabel, store],
  );

  const toggle = useCallback(() => {
    if (!canTrace) return;
    setArmed((current) => {
      const next = !current;
      setStatusMessage(next ? buildTracePrompt() : null);
      return next;
    });
  }, [buildTracePrompt, canTrace]);

  useEffect(() => {
    if (canTrace) return;
    setArmed(false);
  }, [canTrace]);

  useEffect(() => {
    if (!armed) return;
    setStatusMessage(buildTracePrompt());
  }, [armed, buildTracePrompt]);

  useEffect(() => {
    if (!armed || !map) return;

    const canvas = map.getCanvas();
    const applyCursor = () => {
      canvas.style.cursor = TRACE_CURSOR;
    };

    const handleClick = (event: MapMouseEvent) => {
      if (!appendPointAt(event.lngLat.lng, event.lngLat.lat)) return;
      canvas.style.cursor = TRACE_CURSOR;
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
  }, [appendPointAt, armed, deactivate, map]);

  const value = useMemo<TraceToolContextValue>(
    () => ({
      armed,
      canTrace,
      statusMessage,
      toggle,
      deactivate,
    }),
    [armed, canTrace, deactivate, statusMessage, toggle],
  );

  return (
    <TraceToolContext.Provider value={value}>
      {children}
    </TraceToolContext.Provider>
  );
}

export function useTraceToolOptional(): TraceToolContextValue | null {
  return useContext(TraceToolContext);
}