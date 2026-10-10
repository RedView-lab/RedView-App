import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { SportDiscipline } from '@/shared/lib/discipline';
import { hasUsableRouteElevation } from '../../lib/schedule';
import type { Itinerary, ItineraryProject } from '../../types';
import { useDerivedComputeGate } from '../../context/ProjectStore/hooks';
import { storedPredictionStillValid } from './signatures';
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
 * valable (cf. storedPredictionStillValid) est gardée telle quelle.
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
  const { gate, retryNonce: gateRetryNonce, markWaiting: markWaitingForGate } = useDerivedComputeGate();

  useEffect(() => {
    if (!active || !activeCalculationSignature) return;

    const itineraryId = active.id;
    const lastSig = lastProcessedSignatureRef.current[itineraryId];

    // Prédiction stockée encore valable pour les entrées actuelles : gardée
    // (réouverture, retour d'un annuler, calcul d'un autre éditeur).
    if (storedPredictionStillValid(active, activeDiscipline, { firstPass: !lastSig })) {
      lastProcessedSignatureRef.current[itineraryId] = activeCalculationSignature;
      return;
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

    // Pas de prédiction automatique tant que l'utilisateur n'a pas touché au mode
    // « Rythme ». Les anciens projets (enregistrés avant le drapeau) comptent comme
    // configurés quand ils portent déjà une prédiction ou des envois FIT.
    const rhythmConfigured =
      active.rhythmConfigured === true
      || active.prediction != null
      || (active.fitUploads?.length ?? 0) > 0
      || active.pendingFitRecompute === true;
    if (!rhythmConfigured) return;

    if (active.gpxRoute.source === 'brouter' && !active.routeAudit) return;
    if (!hasUsableRouteElevation(active.gpxRoute.points)) return;
    // Co-édition : entrées modifiées par un autre éditeur, qui calcule.
    if (!gate.shouldCompute('prediction', itineraryId)) {
      markWaitingForGate();
      return;
    }

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
    gate,
    gateRetryNonce,
    handleCalculatePrediction,
    markWaitingForGate,
    predictionStore,
    setProject,
    updateFitRuntime,
  ]);
}
