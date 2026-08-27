import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import { createFitPredictionEngine } from '@/features/fitPredictor/engine/api';
import type { PredictionResult } from '@/features/fitPredictor';
import {
  uploadProjectItineraryFitFiles,
} from '@/shared/utils/projects';

import {
  buildPredictionConfigFromRhythm,
  buildRouteGpxFile,
  hasUsableRouteElevation,
} from '../../lib/schedule';
import { buildPauseAwareSchedule } from '../../lib/schedule';
import { buildFitUploadsSignature } from '../../lib/schedule';

import {
  buildLocalFitUploadSignature,
  fitFilesEqual,
  mergeFitFiles,
} from './files';
import { hydratePersistedFitRuntime } from './hydration';
import { buildFitStatusText, buildUploadFitLabel } from './labels';
import { translateAppText } from '@/shared/i18n';
import {
  createEmptyFitRuntime,
  type ItineraryFitRuntime,
  type UseItineraryFitRuntimeArgs,
} from './types';

export function useItineraryFitRuntime({
  active,
  projectId,
  predictionStore,
  setProject,
}: UseItineraryFitRuntimeArgs) {
  const fitInputRef = useRef<HTMLInputElement | null>(null);
  const fitUploadTargetIdRef = useRef<string | null>(null);
  const cancelledPredictionIdsRef = useRef<Set<string>>(new Set());
  const fitEngineRef = useRef<ReturnType<typeof createFitPredictionEngine> | null>(
    null,
  );
  const [fitRuntimeByItineraryId, setFitRuntimeByItineraryId] = useState<
    Record<string, ItineraryFitRuntime>
  >({});
  const fitRuntimeRef = useRef(fitRuntimeByItineraryId);
  const failedHydrationSignatureRef = useRef<Record<string, string>>({});
  fitRuntimeRef.current = fitRuntimeByItineraryId;

  useEffect(() => {
    fitEngineRef.current = createFitPredictionEngine();
    return () => {
      fitEngineRef.current?.terminate();
      fitEngineRef.current = null;
    };
  }, []);

  const activeFitRuntime = useMemo(
    () =>
      active ? fitRuntimeByItineraryId[active.id] ?? createEmptyFitRuntime() : null,
    [active, fitRuntimeByItineraryId],
  );
  const activeRouteSignature = useMemo(() => {
    const points = active?.gpxRoute?.points;
    if (!points || points.length < 2) return '';
    const first = points[0];
    const last = points[points.length - 1];
    return [
      points.length,
      first ? `${first.lon.toFixed(5)},${first.lat.toFixed(5)}` : '',
      last ? `${last.lon.toFixed(5)},${last.lat.toFixed(5)}` : '',
      last?.distanceM ?? '',
    ].join('|');
  }, [active?.gpxRoute?.points]);
  const activePersistedUploadSignature = active
    ? buildFitUploadsSignature(active.fitUploads ?? [])
    : '';
  const activePrediction = active?.prediction ?? null;
  const activeFitHydrationInput = useMemo(
    () =>
      active
        ? {
            fitUploads: active.fitUploads ?? [],
            prediction: activePrediction,
          }
        : null,
    [active?.id, activePersistedUploadSignature, activePrediction],
  );

  const lastProcessedSignatureRef = useRef<Record<string, string>>({});
  const calculateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeRhythmSignature = useMemo(() => {
    if (!active?.rhythm) return '';
    return JSON.stringify(active.rhythm);
  }, [active?.rhythm]);

  const activeCalculationSignature = useMemo(() => {
    if (!active || !activeRouteSignature) return '';
    return `${active.id}::${activeRouteSignature}::${activeRhythmSignature}::${activePersistedUploadSignature}`;
  }, [active, activeRouteSignature, activeRhythmSignature, activePersistedUploadSignature]);

  const uploadFitLabel = useMemo(
    () => buildUploadFitLabel(activeFitRuntime),
    [activeFitRuntime],
  );

  const fitStatusText = useMemo(
    () => buildFitStatusText(activeFitRuntime),
    [activeFitRuntime],
  );

  const calculateLabel = useMemo(() => {
    if (fitStatusText) return fitStatusText;
    return translateAppText('Calculer');
  }, [fitStatusText]);

  const calculateDisabled = activeFitRuntime?.status === 'running';

  const replaceFitEngine = useCallback(() => {
    fitEngineRef.current?.terminate();
    fitEngineRef.current = createFitPredictionEngine();
  }, []);

  const updateFitRuntime = useCallback(
    (
      itineraryId: string,
      mut: (current: ItineraryFitRuntime) => ItineraryFitRuntime,
    ) => {
      setFitRuntimeByItineraryId((prev) => {
        const current = prev[itineraryId] ?? createEmptyFitRuntime();
        const next = mut(current);
        if (next === current) return prev;
        return { ...prev, [itineraryId]: next };
      });
    },
    [],
  );

  useEffect(() => {
    if (!active || !activeFitHydrationInput) return;

    const itineraryId = active.id;
    const persistedUploadSignature = activePersistedUploadSignature;
    const currentRuntime =
      fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();

    const alreadyFailedSameSignature =
      currentRuntime.fitFiles.length === 0
      && currentRuntime.persistedUploadSignature === persistedUploadSignature
      && failedHydrationSignatureRef.current[itineraryId] === persistedUploadSignature;

    if (alreadyFailedSameSignature) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const hydrated = await hydratePersistedFitRuntime(activeFitHydrationInput);
        if (cancelled) return;

        delete failedHydrationSignatureRef.current[itineraryId];

        updateFitRuntime(itineraryId, (current) => {
          const shouldReuseLoadedFiles =
            persistedUploadSignature.length > 0
            && current.persistedUploadSignature === persistedUploadSignature
            && current.fitFiles.length > 0;
          const shouldPreserveLocalFiles =
            persistedUploadSignature.length === 0
            && current.persistedUploadSignature.length > 0
            && current.fitFiles.length > 0;
          const nextFitFiles =
            shouldReuseLoadedFiles || shouldPreserveLocalFiles
              ? current.fitFiles
              : hydrated.fitFiles;
          const nextFitFileNames = nextFitFiles.map((file) => file.name);

          if (
            current.persistedUploadSignature === hydrated.persistedUploadSignature
            && current.predictionResult === hydrated.predictionResult
            && fitFilesEqual(current.fitFiles, nextFitFiles)
          ) {
            return current;
          }

          return {
            ...current,
            fitFiles: nextFitFiles,
            fitFileNames: nextFitFileNames,
            predictionResult: hydrated.predictionResult,
            progress: current.status === 'running' ? current.progress : [],
            status:
              current.status === 'running'
                ? current.status
                : hydrated.predictionResult
                  ? 'success'
                  : nextFitFiles.length > 0
                    ? 'ready'
                    : 'idle',
            error: current.status === 'running' ? current.error : null,
            persistedUploadSignature: hydrated.persistedUploadSignature,
          };
        });
      } catch (error) {
        if (cancelled) return;

        failedHydrationSignatureRef.current[itineraryId] =
          persistedUploadSignature;

        console.error('[fit-predictor] failed to hydrate persisted FIT uploads', error);
        updateFitRuntime(itineraryId, (current) => {
          if (current.fitFiles.length > 0) {
            return {
              ...current,
              predictionResult: activePrediction,
              persistedUploadSignature,
            };
          }

          return {
            ...current,
            fitFiles: [],
            fitFileNames: [],
            predictionResult: activePrediction,
            progress: [],
            status: 'error',
            error:
              error instanceof Error
                ? translateAppText(error.message)
                : translateAppText('Impossible de recharger les fichiers FIT du projet.'),
            updatedAt: new Date().toISOString(),
            persistedUploadSignature,
          };
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active?.id, activeFitHydrationInput, activePersistedUploadSignature, activePrediction, updateFitRuntime]);

  const handleUploadFitRequest = useCallback(() => {
    if (!active) return;
    fitUploadTargetIdRef.current = active.id;
    if (fitInputRef.current) {
      fitInputRef.current.value = '';
      fitInputRef.current.click();
    }
  }, [active]);

  const handleFitInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const itineraryId = fitUploadTargetIdRef.current ?? active?.id;
      if (!itineraryId) return;

      const incoming = Array.from(event.target.files ?? []).filter((file) =>
        file.name.toLowerCase().endsWith('.fit'),
      );
      if (incoming.length === 0) return;

      const current = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();
      const nextFitFiles = mergeFitFiles(current.fitFiles, incoming);
      const nextFitFileNames = nextFitFiles.map((file) => file.name);
      const localSignature = buildLocalFitUploadSignature(nextFitFiles);

      updateFitRuntime(itineraryId, (prev) => ({
        ...prev,
        fitFiles: nextFitFiles,
        fitFileNames: nextFitFileNames,
        status: 'ready',
        error: null,
        persistedUploadSignature: localSignature,
      }));

      if (!projectId) return;

      try {
        const storedUploads = await uploadProjectItineraryFitFiles(
          projectId,
          itineraryId,
          nextFitFiles,
        );

        setProject((prev) => {
          const nextItineraries = prev.itineraries.map((it) =>
            it.id === itineraryId
              ? {
                  ...it,
                  fitUploads: storedUploads,
                  prediction: undefined,
                  pendingFitRecompute: true,
                }
              : it,
          );
          return {
            ...prev,
            itineraries: nextItineraries,
          };
        });
        predictionStore?.setPrediction(itineraryId, null);
      } catch (error) {
        console.error('[fit-predictor] upload persistence error', error);
        updateFitRuntime(itineraryId, (prev) => ({
          ...prev,
          status: 'error',
          error:
            error instanceof Error
              ? translateAppText(error.message)
              : translateAppText('Impossible de sauvegarder les fichiers FIT sur le serveur.'),
          updatedAt: new Date().toISOString(),
        }));
      }
    },
    [active?.id, predictionStore, projectId, setProject, updateFitRuntime],
  );

  const handleCalculatePrediction = useCallback(() => {
    const itinerary = active;
    if (!itinerary) return;

    const runtime = fitRuntimeRef.current[itinerary.id] ?? createEmptyFitRuntime();
    if (runtime.fitFiles.length === 0) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: translateAppText('Chargez au moins un fichier FIT avant de calculer.'),
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

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
    cancelledPredictionIdsRef.current.delete(itineraryId);
    const gpxFile = buildRouteGpxFile(itinerary);
    const config = buildPredictionConfigFromRhythm(
      itinerary.rhythm,
      itinerary.gpxRoute?.points ?? null,
    );

    updateFitRuntime(itineraryId, (current) => ({
      ...current,
      predictionResult: null,
      progress: [],
      status: 'running',
      error: null,
      updatedAt: new Date().toISOString(),
    }));
    predictionStore?.setPrediction(itineraryId, null);

    void engine
      .predict(runtime.fitFiles, gpxFile, config, (message: string) => {
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          progress: [...current.progress.slice(-19), message],
          status: 'running',
        }));
      })
      .then((result: PredictionResult) => {
        cancelledPredictionIdsRef.current.delete(itineraryId);
        setProject((prev) => ({
          ...prev,
          itineraries: prev.itineraries.map((curr) =>
            curr.id === itineraryId
              ? {
                  ...curr,
                  prediction: result,
                  pendingFitRecompute: undefined,
                  metrics: {
                    ...curr.metrics,
                    durationSec: buildPauseAwareSchedule(curr, result)?.totalDurationSeconds ?? result.total_time_s,
                  },
                }
              : curr,
          ),
        }));
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
        const wasCancelled =
          cancelledPredictionIdsRef.current.has(itineraryId)
          && error instanceof Error
          && error.message === 'Prediction worker terminated';
        if (wasCancelled) {
          cancelledPredictionIdsRef.current.delete(itineraryId);
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
  }, [active, predictionStore, setProject, updateFitRuntime]);

  const cancelCalculatePrediction = useCallback(() => {
    const itinerary = active;
    if (!itinerary) return;

    const runtime = fitRuntimeRef.current[itinerary.id] ?? createEmptyFitRuntime();
    if (runtime.status !== 'running') return;

    cancelledPredictionIdsRef.current.add(itinerary.id);
    replaceFitEngine();

    updateFitRuntime(itinerary.id, (current) => ({
      ...current,
      predictionResult: itinerary.prediction ?? current.predictionResult,
      progress: [],
      status: itinerary.prediction ? 'success' : current.fitFiles.length > 0 ? 'ready' : 'idle',
      error: null,
      updatedAt: new Date().toISOString(),
    }));
    predictionStore?.setPrediction(itinerary.id, itinerary.prediction ?? null);
  }, [active, predictionStore, replaceFitEngine, updateFitRuntime]);

  useEffect(() => {
    if (!active || !activeCalculationSignature) return;

    const itineraryId = active.id;
    const lastSig = lastProcessedSignatureRef.current[itineraryId];

    // If this is the initial load for this itinerary and we already have a matching prediction
    if (!lastSig) {
      const lastPointDistM = active.gpxRoute?.points[active.gpxRoute.points.length - 1]?.distanceM ?? 0;
      const predDistM = active.prediction?.total_distance_m ?? 0;
      const isDistMismatched = active.prediction && Math.abs(predDistM - lastPointDistM) > 500;

      if (active.prediction && !isDistMismatched) {
        lastProcessedSignatureRef.current[itineraryId] = activeCalculationSignature;
        return;
      }
    }

    if (lastSig === activeCalculationSignature && active.pendingFitRecompute !== true) {
      return;
    }

    const runtime = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();
    const hasFitFiles = runtime.fitFiles.length > 0 || (active.fitUploads && active.fitUploads.length > 0);

    if (calculateTimeoutRef.current) {
      clearTimeout(calculateTimeoutRef.current);
      calculateTimeoutRef.current = null;
    }

    if (!hasFitFiles) {
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

    if (!active.gpxRoute || active.gpxRoute.points.length < 2) return;
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
    handleCalculatePrediction,
    predictionStore,
    setProject,
    updateFitRuntime,
  ]);

  return {
    calculateDisabled,
    calculateLabel,
    cancelCalculatePrediction,
    fitInputRef,
    handleCalculatePrediction,
    handleFitInputChange,
    handleUploadFitRequest,
    uploadFitLabel,
  };
}