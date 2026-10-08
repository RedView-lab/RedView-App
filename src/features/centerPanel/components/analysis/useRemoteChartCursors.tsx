import { useCallback, useMemo } from 'react';
import { useLivePresenceOptional } from '@/features/livePresence/context/LivePresenceContext';
import { RemoteChartCursors } from '@/features/livePresence/components/RemoteChartCursors';
import type { PredictionResult } from '@/features/fitPredictor';
import { buildPauseAwareSchedule } from '@/features/itineraryPanel/lib/schedule';
import { getItineraryStartDistanceKm } from '@/features/itineraryPanel/lineage/itineraryLineage';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { xValueFromDistance } from '../../flyover/playback';
import { getRoutePointDistances, type AxisMode } from '../chart';

/**
 * Co-édition : point survolé par les autres (itinéraire, distance depuis son
 * départ) → abscisse dans le mode d'axe de cet éditeur ; ligne à leur couleur.
 */
export function useRemoteChartCursors(
  itineraries: readonly Itinerary[],
  predictions: Record<string, unknown> | null,
  xMode: AxisMode,
) {
  const livePresence = useLivePresenceOptional();
  const hasLivePresence = livePresence !== null;
  const remoteChartContexts = useMemo(() => {
    const contexts = new Map<string, {
      prediction: PredictionResult | null;
      totalDistanceM: number;
      startTime: string | null;
      pauseSchedule: ReturnType<typeof buildPauseAwareSchedule> | null;
      startOffsetKm: number;
    }>();
    if (!hasLivePresence) return contexts;
    for (const itinerary of itineraries) {
      const points = itinerary.gpxRoute?.points;
      if (itinerary.analysisVisible === false || !points || points.length < 2) continue;
      const prediction = ((predictions?.[itinerary.id] as PredictionResult | undefined) ?? itinerary.prediction ?? null) as PredictionResult | null;
      const distances = getRoutePointDistances(points);
      contexts.set(itinerary.id, {
        prediction,
        totalDistanceM: distances[distances.length - 1] ?? 0,
        startTime: itinerary.rhythm.startTime ?? null,
        pauseSchedule: xMode === 'distance' ? null : buildPauseAwareSchedule(itinerary, prediction),
        startOffsetKm: xMode === 'distance' ? getItineraryStartDistanceKm(itinerary) : 0,
      });
    }
    return contexts;
  }, [hasLivePresence, itineraries, predictions, xMode]);
  const remoteToChartX = useCallback((itineraryId: string, distanceM: number): number | null => {
    const context = remoteChartContexts.get(itineraryId);
    if (!context) return null;
    const x = xValueFromDistance(distanceM, { ...context, xMode });
    return Number.isFinite(x) ? x + context.startOffsetKm : null;
  }, [remoteChartContexts, xMode]);
  const renderRemoteChartCursors = useCallback(
    ({ xDomain }: { xDomain: { min: number; max: number } }) => <RemoteChartCursors xDomain={xDomain} toChartX={remoteToChartX} />,
    [remoteToChartX],
  );
  return { hasLivePresence, renderRemoteChartCursors };
}
