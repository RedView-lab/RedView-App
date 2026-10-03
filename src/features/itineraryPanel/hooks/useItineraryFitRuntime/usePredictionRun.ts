import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  FitPredictionCancelledError,
  createFitPredictionEngine,
} from '@/features/fitPredictor/engine/api';
import type { PredictionResult } from '@/features/fitPredictor';
import { engineRejectionReason, parseFailingFitIndex } from '@/features/fitPredictor/lib/fitFileValidation';
import { translateAppText } from '@/shared/i18n';
import { isFootDiscipline, normalizeDiscipline } from '@/shared/lib/discipline';
import {
  buildPauseAwareSchedule,
  buildRouteGpxFile,
  buildRunPredictionConfigFromRhythm,
  hasUsableRouteElevation,
} from '../../lib/schedule';
import { isCustomRhythmProfile } from '../../lib/rhythm/profile';
import type { Itinerary, ItineraryProject } from '../../types';
import { predictCyclingItinerary, type CyclingCalibrationCache } from './cycling';
import { fitFileKey } from './files';
import { buildPredictionInputSignature } from './signatures';
import {
  createEmptyFitRuntime,
  type ExcludeFitFiles,
  type FitRuntimeRef,
  type PredictionStoreBridge,
  type UpdateFitRuntime,
} from './types';

interface UsePredictionRunArgs {
  active: Itinerary | null;
  predictionStore: PredictionStoreBridge | null;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  fitRuntimeRef: FitRuntimeRef;
  updateFitRuntime: UpdateFitRuntime;
  excludeFitFiles: ExcludeFitFiles;
}

/**
 * Calcul de la prédiction de l'itinéraire actif dans le worker (moteur vélo v2
 * ou course à pied), annulation, et écriture du résultat seulement s'il décrit
 * encore l'état courant du tracé et du rythme.
 */
export function usePredictionRun({
  active,
  predictionStore,
  setProject,
  fitRuntimeRef,
  updateFitRuntime,
  excludeFitFiles,
}: UsePredictionRunArgs) {
  const latestPredictionRunRef = useRef<Record<string, number>>({});
  const fitEngineRef = useRef<ReturnType<typeof createFitPredictionEngine> | null>(
    null,
  );
  const cyclingCalibrationCacheRef = useRef<CyclingCalibrationCache>(new Map());

  useEffect(() => {
    fitEngineRef.current = createFitPredictionEngine();
    return () => {
      fitEngineRef.current?.terminate();
      fitEngineRef.current = null;
    };
  }, []);

  const handleCalculatePrediction = useCallback(() => {
    const itinerary = active;
    if (!itinerary) return;

    const runtime = fitRuntimeRef.current[itinerary.id] ?? createEmptyFitRuntime();

    if (!itinerary.gpxRoute || itinerary.gpxRoute.points.length < 2) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: translateAppText('L’itinéraire actif n’a pas encore de trace GPX exploitable.'),
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    if (!hasUsableRouteElevation(itinerary.gpxRoute.points)) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error:
          itinerary.gpxRoute?.source === 'brouter'
            ? translateAppText('Le profil altimetrique du trace BRouter n\'est pas encore pret. Relancez le calcul quand le trace est charge.')
            : translateAppText('Le GPX actif ne contient pas assez d\'altitudes exploitables pour la prediction.'),
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const engine = fitEngineRef.current;
    if (!engine) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: translateAppText('Le moteur de prediction FIT n’est pas prêt.'),
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const itineraryId = itinerary.id;
    const discipline = normalizeDiscipline(itinerary.discipline);
    const routePoints = itinerary.gpxRoute?.points ?? null;
    const inputSignature = buildPredictionInputSignature(itinerary);
    const runId = (latestPredictionRunRef.current[itineraryId] ?? 0) + 1;
    latestPredictionRunRef.current[itineraryId] = runId;

    updateFitRuntime(itineraryId, (current) => ({
      ...current,
      predictionResult: null,
      progress: [],
      status: 'running',
      error: null,
      updatedAt: new Date().toISOString(),
    }));
    predictionStore?.setPrediction(itineraryId, null);

    const onProgress = (message: string) => {
      updateFitRuntime(itineraryId, (current) => ({
        ...current,
        progress: [...current.progress.slice(-19), message],
        status: 'running',
      }));
    };
    // Running / trail use their own engine; the result is stamped with the
    // discipline so displays (pace vs km/h) always match the engine used.
    // Les .fit ne comptent qu'en profil "Personalisé". Vélo : moteur v2
    // (calibration .fit mise en cache, tracé complet).
    const fitFiles = isCustomRhythmProfile(itinerary.rhythm) ? runtime.fitFiles : [];
    const pending = isFootDiscipline(discipline)
      ? engine.predictRun(
          fitFiles,
          buildRouteGpxFile(itinerary),
          buildRunPredictionConfigFromRhythm(itinerary.rhythm, discipline, routePoints),
          onProgress,
          { key: itineraryId },
        )
      : predictCyclingItinerary(
          engine,
          itinerary,
          fitFiles,
          cyclingCalibrationCacheRef.current,
          onProgress,
          { key: itineraryId },
        );

    void pending
      .then((raw: PredictionResult) => {
        const result: PredictionResult = { ...raw, discipline };
        // Le tracé / rythme a changé pendant le calcul (undo, édition) : ce
        // résultat décrit un autre état, on ne l'écrit pas. Le recalcul
        // automatique repart sur l'état courant.
        let applied = false;
        setProject((prev) => {
          const target = prev.itineraries.find((curr) => curr.id === itineraryId);
          if (!target || buildPredictionInputSignature(target) !== inputSignature) return prev;
          applied = true;
          return {
            ...prev,
            itineraries: prev.itineraries.map((curr) =>
              curr.id === itineraryId
                ? {
                    ...curr,
                    prediction: result,
                    rhythmConfigured: true,
                    pendingFitRecompute: undefined,
                    metrics: {
                      ...curr.metrics,
                      durationSec: buildPauseAwareSchedule(curr, result)?.totalDurationSeconds ?? result.total_time_s,
                    },
                  }
                : curr,
            ),
          };
        });
        if (!applied) {
          if (latestPredictionRunRef.current[itineraryId] === runId) {
            updateFitRuntime(itineraryId, (current) => ({
              ...current,
              progress: [],
              status: current.fitFiles.length > 0 ? 'ready' : 'idle',
              updatedAt: new Date().toISOString(),
            }));
          }
          return;
        }
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          predictionResult: result,
          status: 'success',
          error: null,
          updatedAt: new Date().toISOString(),
        }));
        predictionStore?.setPrediction(itineraryId, result);
      })
      .catch((error: unknown) => {
        // Remplacée par un calcul plus récent, annulée, ou moteur arrêté
        // (démontage) : pas une erreur à afficher.
        if (error instanceof FitPredictionCancelledError) return;
        // L'échec d'un calcul périmé ne doit ni afficher d'erreur sur le
        // calcul courant ni effacer son pendingFitRecompute.
        if (latestPredictionRunRef.current[itineraryId] !== runId) return;
        // Un .fit passé au contrôle d'en-tête mais refusé par le moteur
        // (« Error parsing FIT file #N ») : on l'écarte et on relance sans lui
        // plutôt que de bloquer toute la prédiction.
        const failingIndex = error instanceof Error ? parseFailingFitIndex(error.message) : null;
        const failingFile = failingIndex !== null ? fitFiles[failingIndex] : undefined;
        if (failingFile) {
          console.warn('[fit-predictor] FIT file rejected by the engine, retrying without it', failingFile.name, error);
          const failingKey = fitFileKey(failingFile);
          updateFitRuntime(itineraryId, (current) => ({
            ...current,
            progress: [],
            status: current.fitFiles.some((file) => fitFileKey(file) !== failingKey) ? 'ready' : 'idle',
            updatedAt: new Date().toISOString(),
          }));
          excludeFitFiles(
            itineraryId,
            itinerary.fitUploads ?? [],
            [{ file: failingFile, reason: engineRejectionReason(error instanceof Error ? error.message : '') }],
            true,
          );
          return;
        }
        console.error('[fit-predictor] prediction failed', error);
        setProject((prev) => ({
          ...prev,
          itineraries: prev.itineraries.map((curr) =>
            curr.id === itineraryId
              ? {
                  ...curr,
                  pendingFitRecompute: undefined,
                }
              : curr,
          ),
        }));
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          predictionResult: null,
          status: 'error',
          error:
            error instanceof Error
              ? translateAppText(error.message)
              : translateAppText('Erreur inconnue pendant la prediction FIT.'),
          updatedAt: new Date().toISOString(),
        }));
        predictionStore?.setPrediction(itineraryId, null);
      });
  }, [active, excludeFitFiles, fitRuntimeRef, predictionStore, setProject, updateFitRuntime]);

  const cancelCalculatePrediction = useCallback(() => {
    const itinerary = active;
    if (!itinerary) return;

    const runtime = fitRuntimeRef.current[itinerary.id] ?? createEmptyFitRuntime();
    if (runtime.status !== 'running') return;

    // N'annule que les calculs de cet itinéraire : ceux des autres restent en
    // file et reprennent sur un worker neuf.
    fitEngineRef.current?.cancel(itinerary.id);

    updateFitRuntime(itinerary.id, (current) => ({
      ...current,
      predictionResult: itinerary.prediction ?? current.predictionResult,
      progress: [],
      status: itinerary.prediction ? 'success' : current.fitFiles.length > 0 ? 'ready' : 'idle',
      error: null,
      updatedAt: new Date().toISOString(),
    }));
    predictionStore?.setPrediction(itinerary.id, itinerary.prediction ?? null);
  }, [active, fitRuntimeRef, predictionStore, updateFitRuntime]);

  return { handleCalculatePrediction, cancelCalculatePrediction };
}
