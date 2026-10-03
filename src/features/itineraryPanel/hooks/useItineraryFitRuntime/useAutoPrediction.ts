import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { resolvePredictionDiscipline, type SportDiscipline } from '@/shared/lib/discipline';
import { hasUsableRouteElevation } from '../../lib/schedule';
import type { Itinerary, ItineraryProject } from '../../types';
import { isCyclingPredictionOutdated } from './cycling';
import {
  createEmptyFitRuntime,
  type FitRuntimeRef,
  type PredictionStoreBridge,
  type UpdateFitRuntime,
} from './types';

interface UseAutoPredictionArgs {
  active: Itinerary | null;
  /** Itinéraire + discipline + tracé + rythme + uploads : tout changement relance le calcul. */
  activeCalculationSignature: string;
  activeDiscipline: SportDiscipline;
  handleCalculatePrediction: () => void;
  predictionStore: PredictionStoreBridge | null;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  fitRuntimeRef: FitRuntimeRef;
  updateFitRuntime: UpdateFitRuntime;
}

/**
 * Recalcul automatique (débounce 300 ms) quand les entrées de la prédiction
 * changent, une fois le rythme configuré ; une prédiction chargée encore
 * valable (distance, discipline, version du moteur) est gardée telle quelle.
 */
export function useAutoPrediction({
  active,
  activeCalculationSignature,
  activeDiscipline,
  handleCalculatePrediction,
  predictionStore,
  setProject,
  fitRuntimeRef,
  updateFitRuntime,
}: UseAutoPredictionArgs): void {
  const lastProcessedSignatureRef = useRef<Record<string, string>>({});
  const calculateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active || !activeCalculationSignature) return;

    const itineraryId = active.id;
    const lastSig = lastProcessedSignatureRef.current[itineraryId];

    // If this is the initial load for this itinerary and we already have a matching prediction
    if (!lastSig) {
      const lastPointDistM = active.gpxRoute?.points[active.gpxRoute.points.length - 1]?.distanceM ?? 0;
      const predDistM = active.prediction?.total_distance_m ?? 0;
      const isDistMismatched = active.prediction && Math.abs(predDistM - lastPointDistM) > 500;
      const isDisciplineMismatched =
        active.prediction && resolvePredictionDiscipline(active.prediction) !== activeDiscipline;
      // Prédiction vélo d'un moteur plus ancien : recalculée avec le moteur courant.
      const isEngineOutdated = isCyclingPredictionOutdated(active.prediction);

      if (active.prediction && !isDistMismatched && !isDisciplineMismatched && !isEngineOutdated) {
        lastProcessedSignatureRef.current[itineraryId] = activeCalculationSignature;
        return;
      }
    }

    if (lastSig === activeCalculationSignature && active.pendingFitRecompute !== true) {
      return;
    }

    const runtime = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();

    if (calculateTimeoutRef.current) {
      clearTimeout(calculateTimeoutRef.current);
      calculateTimeoutRef.current = null;
    }

    if (!active.gpxRoute || active.gpxRoute.points.length < 2) {
      lastProcessedSignatureRef.current[itineraryId] = activeCalculationSignature;
      if (active.prediction || runtime.predictionResult) {
        predictionStore?.setPrediction(itineraryId, null);
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          predictionResult: null,
          status: 'idle',
        }));
        setProject((prev) => ({
          ...prev,
          itineraries: prev.itineraries.map((curr) =>
            curr.id === itineraryId
              ? {
                  ...curr,
                  prediction: undefined,
                  pendingFitRecompute: undefined,
                  metrics: {
                    ...curr.metrics,
                    durationSec: undefined,
                  },
                }
              : curr,
          ),
        }));
      }
      return;
    }

    // No automatic prediction until the user has touched the "Rythme" mode.
    // Legacy projects (saved before the flag) count as configured when they
    // already carry a prediction or FIT uploads.
    const rhythmConfigured =
      active.rhythmConfigured === true
      || active.prediction != null
      || (active.fitUploads?.length ?? 0) > 0
      || active.pendingFitRecompute === true;
    if (!rhythmConfigured) return;

    if (active.gpxRoute.source === 'brouter' && !active.routeAudit) return;
    if (!hasUsableRouteElevation(active.gpxRoute.points)) return;

    calculateTimeoutRef.current = setTimeout(() => {
      lastProcessedSignatureRef.current[itineraryId] = activeCalculationSignature;
      handleCalculatePrediction();
    }, 300);

    return () => {
      if (calculateTimeoutRef.current) {
        clearTimeout(calculateTimeoutRef.current);
        calculateTimeoutRef.current = null;
      }
    };
  }, [
    active,
    activeCalculationSignature,
    activeDiscipline,
    fitRuntimeRef,
    handleCalculatePrediction,
    predictionStore,
    setProject,
    updateFitRuntime,
  ]);
}
