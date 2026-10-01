import { useEffect, useRef, useState } from 'react';
import type { Itinerary } from '@/features/itineraryPanel/types';
import {
  fetchRouteWeatherDataset,
  type RouteWeatherDataset,
} from '../lib/routeWeather';
import {
  formatLocalDateIso,
  getForecastDateForOffset,
  minutesToTime,
} from '../lib/forecastTime';

interface UseRouteWeatherOptions {
  itineraries: Itinerary[];
  fallbackDate?: string | null;
  fallbackTime?: string | null;
  enabled?: boolean;
  /** Prédictions courantes (store) : leur durée dimensionne la plage de prévision. */
  predictions?: Record<string, unknown> | null;
}

interface UseRouteWeatherResult {
  weatherByItinerary: Record<string, RouteWeatherDataset | null>;
  /** Itinéraires pour lesquels aucune prévision n'a pu être obtenue (erreur, hors horizon). */
  unavailableItineraryIds: string[];
  loading: boolean;
  error: string | null;
}

function readTotalTimeHours(prediction: unknown): number | null {
  const totalS = (prediction as { total_time_s?: unknown } | null | undefined)?.total_time_s;
  return typeof totalS === 'number' && Number.isFinite(totalS) && totalS > 0 ? totalS / 3600 : null;
}

export function useRouteWeather({
  itineraries,
  fallbackDate,
  fallbackTime,
  enabled = true,
  predictions,
}: UseRouteWeatherOptions): UseRouteWeatherResult {
  const [weatherByItinerary, setWeatherByItinerary] = useState<
    Record<string, RouteWeatherDataset | null>
  >({});
  const [unavailableItineraryIds, setUnavailableItineraryIds] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || itineraries.length === 0) {
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const now = new Date();
    const defaultDate = fallbackDate || getForecastDateForOffset(0, now);
    const defaultTime = fallbackTime || minutesToTime(now.getHours() * 60);

    let isMounted = true;
    setLoading(true);
    setError(null);

    async function loadWeatherForRoutes() {
      try {
        const entries: Array<[string, RouteWeatherDataset | null]> = [];

        for (const itinerary of itineraries) {
          if (controller.signal.aborted) return;
          const points = itinerary.gpxRoute?.points;
          if (!points || points.length === 0) continue;

          const startDate = itinerary.rhythm?.startDate || defaultDate || formatLocalDateIso(now);
          const startTime = itinerary.rhythm?.startTime || defaultTime || '12:00';
          const rideDurationHours = readTotalTimeHours(predictions?.[itinerary.id])
            ?? readTotalTimeHours(itinerary.prediction);

          const dataset = await fetchRouteWeatherDataset(
            itinerary.id,
            points,
            startDate,
            startTime,
            controller.signal,
            { rideDurationHours },
          );

          // null = prévisions indisponibles : on efface toute donnée périmée
          // (autre date de départ) au lieu de la laisser affichée.
          entries.push([itinerary.id, dataset]);
        }

        if (isMounted && !controller.signal.aborted) {
          setWeatherByItinerary((prev) => {
            const next = { ...prev };
            for (const [id, ds] of entries) {
              next[id] = ds;
            }
            return next;
          });
          setUnavailableItineraryIds(entries.filter(([, ds]) => !ds).map(([id]) => id));
          setLoading(false);
        }
      } catch (err) {
        if (!isMounted || controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
      }
    }

    loadWeatherForRoutes();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [enabled, fallbackDate, fallbackTime, itineraries, predictions]);

  return {
    weatherByItinerary,
    unavailableItineraryIds,
    loading,
    error,
  };
}
