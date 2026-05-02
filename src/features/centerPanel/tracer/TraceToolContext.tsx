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
  const canTrace = Boolean(
    startRow &&
    startRow.lat != null &&
    startRow.lon != null &&
    endRow &&
    endRow.lat != null &&
    endRow.lon != null,
  );

  const deactivate = useCallback(() => {
    setArmed(false);
    setStatusMessage(null);
  }, []);

  const hydrateEndLabel = useCallback(
    async (itineraryId: string, lon: number, lat: number, fallbackLabel: string) => {
      try {
        const settlement = await reverseGeocodeSettlement(lon, lat, {
          maxDistanceMeters: 1000,
        });
        const resolvedLabel = settlement?.name?.trim() || fallbackLabel;
        store?.updateItinerary(itineraryId, (itinerary) => {
          const currentEnd = itinerary.timeline.find((row) => row.kind === 'end');
          if (!currentEnd || currentEnd.lon !== lon || currentEnd.lat !== lat) return;
          currentEnd.label = resolvedLabel;
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
      const appended = store.appendTracePoint(activeItinerary.id, {
        lat,
        lon,
        label: fallbackLabel,
      });
      if (!appended) return false;

      setArmed(false);
      setStatusMessage('Point ajouté, recalcul du tracé en cours');
      void hydrateEndLabel(activeItinerary.id, lon, lat, fallbackLabel);
      return true;
    },
    [activeItinerary, hydrateEndLabel, store],
  );

  const toggle = useCallback(() => {
    if (!canTrace) return;
    setArmed((current) => {
      const next = !current;
      setStatusMessage(next ? 'Cliquez sur la carte pour prolonger le tracé' : null);
      return next;
    });
  }, [canTrace]);

  useEffect(() => {
    if (canTrace) return;
    setArmed(false);
  }, [canTrace]);

  useEffect(() => {
    if (!armed || !map) return;

    const canvas = map.getCanvas();
    const applyCursor = () => {
      canvas.style.cursor = TRACE_CURSOR;
    };

    const handleClick = (event: MapMouseEvent) => {
      if (!appendPointAt(event.lngLat.lng, event.lngLat.lat)) return;
      canvas.style.cursor = '';
    };

    applyCursor();
    map.on('mousemove', applyCursor);
    map.on('click', handleClick);

    return () => {
      map.off('mousemove', applyCursor);
      map.off('click', handleClick);
      canvas.style.cursor = '';
    };
  }, [appendPointAt, armed, map]);

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