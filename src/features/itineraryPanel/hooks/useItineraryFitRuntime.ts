import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { createFitPredictionEngine } from '@/features/fitPredictor/engine/api';
import type { PredictionResult } from '@/features/fitPredictor';

import {
  buildPredictionConfigFromRhythm,
  buildRouteGpxFile,
  hasUsableRouteElevation,
} from '../lib/container-prediction';
import type { ItineraryProject } from '../types';

type FitRuntimeStatus = 'idle' | 'ready' | 'running' | 'success' | 'error';

interface ItineraryFitRuntime {
  fitFiles: File[];
  fitFileNames: string[];
  predictionResult: PredictionResult | null;
  progress: string[];
  status: FitRuntimeStatus;
  error: string | null;
  updatedAt: string | null;
}

interface PredictionStoreBridge {
  setPrediction: (itineraryId: string, result: PredictionResult | null) => void;
}

interface UseItineraryFitRuntimeArgs {
  active: ItineraryProject['itineraries'][number] | null;
  predictionStore: PredictionStoreBridge | null;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

function createEmptyFitRuntime(): ItineraryFitRuntime {
  return {
    fitFiles: [],
    fitFileNames: [],
    predictionResult: null,
    progress: [],
    status: 'idle',
    error: null,
    updatedAt: null,
  };
}

export function useItineraryFitRuntime({
  active,
  predictionStore,
  setProject,
}: UseItineraryFitRuntimeArgs) {
  const fitInputRef = useRef<HTMLInputElement | null>(null);
  const fitUploadTargetIdRef = useRef<string | null>(null);
  const fitEngineRef = useRef<ReturnType<typeof createFitPredictionEngine> | null>(
    null,
  );
  const [fitRuntimeByItineraryId, setFitRuntimeByItineraryId] = useState<
    Record<string, ItineraryFitRuntime>
  >({});
  const fitRuntimeRef = useRef(fitRuntimeByItineraryId);
  fitRuntimeRef.current = fitRuntimeByItineraryId;

  useEffect(() => {
    const engine = createFitPredictionEngine();
    fitEngineRef.current = engine;
    return () => {
      engine.terminate();
      fitEngineRef.current = null;
    };
  }, []);

  const activeFitRuntime = useMemo(
    () =>
      active ? fitRuntimeByItineraryId[active.id] ?? createEmptyFitRuntime() : null,
    [active, fitRuntimeByItineraryId],
  );

  const uploadFitLabel = useMemo(() => {
    const count = activeFitRuntime?.fitFiles.length ?? 0;
    if (count <= 0) return 'Upload .fit';
    return count === 1 ? '1 FIT' : `${count} FIT`;
  }, [activeFitRuntime]);

  const fitStatusText = useMemo(() => {
    if (!activeFitRuntime) return null;
    const count = activeFitRuntime.fitFiles.length;
    const countLabel =
      count <= 0 ? null : count === 1 ? '1 fit chargé' : `${count} fit chargés`;
    if (activeFitRuntime.status === 'error' && activeFitRuntime.error) {
      return activeFitRuntime.error;
    }
    if (activeFitRuntime.status === 'running') {
      const progress = activeFitRuntime.progress.at(-1);
      return progress ?? (countLabel ? `${countLabel} · calcul en cours...` : 'Calcul en cours...');
    }
    if (activeFitRuntime.status === 'success') {
      return countLabel
        ? `${countLabel} · prédiction terminée`
        : 'Prédiction terminée';
    }
    if (countLabel) {
      return countLabel;
    }
    return null;
  }, [activeFitRuntime]);

  const calculateLabel = useMemo(() => {
    if (fitStatusText) return fitStatusText;
    return 'Calculer';
  }, [fitStatusText]);

  const calculateDisabled = activeFitRuntime?.status === 'running';

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

  const handleUploadFitRequest = useCallback(() => {
    if (!active) return;
    fitUploadTargetIdRef.current = active.id;
    fitInputRef.current?.click();
  }, [active]);

  const handleFitInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const itineraryId = fitUploadTargetIdRef.current;
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = '';
      if (!itineraryId) return;

      const fitFiles = files.filter((file) => /\.fit$/i.test(file.name));
      if (fitFiles.length === 0) {
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          fitFiles: [],
          fitFileNames: [],
          predictionResult: null,
          progress: [],
          status: 'error',
          error: 'Aucun fichier FIT valide sélectionné.',
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      updateFitRuntime(itineraryId, (current) => ({
        ...current,
        fitFiles,
        fitFileNames: fitFiles.map((file) => file.name),
        predictionResult: null,
        progress: [],
        status: 'ready',
        error: null,
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateFitRuntime],
  );

  const handleCalculatePrediction = useCallback(() => {
    const itinerary = active;
    if (!itinerary) return;

    const runtime = fitRuntimeRef.current[itinerary.id] ?? createEmptyFitRuntime();
    if (runtime.fitFiles.length === 0) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: 'Chargez au moins un fichier FIT avant de calculer.',
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    if (!itinerary.gpxRoute || itinerary.gpxRoute.points.length < 2) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: 'L’itinéraire actif n’a pas encore de trace GPX exploitable.',
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
            ? 'Le profil altimetrique du trace BRouter n\'est pas encore pret. Attendez le chargement du terrain puis relancez le calcul.'
            : 'Le GPX actif ne contient pas assez d\'altitudes exploitables pour la prediction.',
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const engine = fitEngineRef.current;
    if (!engine) {
      updateFitRuntime(itinerary.id, (current) => ({
        ...current,
        status: 'error',
        error: 'Le moteur de prediction FIT n’est pas prêt.',
        updatedAt: new Date().toISOString(),
      }));
      return;
    }

    const itineraryId = itinerary.id;
    const gpxFile = buildRouteGpxFile(itinerary);
    const config = buildPredictionConfigFromRhythm(itinerary.rhythm);

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
        setProject((prev) => ({
          ...prev,
          itineraries: prev.itineraries.map((curr) =>
            curr.id === itineraryId
              ? {
                  ...curr,
                  metrics: {
                    ...curr.metrics,
                    durationSec: result.total_time_s,
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
        console.error('[fit-predictor] prediction failed', error);
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          predictionResult: null,
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Erreur inconnue pendant la prediction FIT.',
          updatedAt: new Date().toISOString(),
        }));
        predictionStore?.setPrediction(itineraryId, null);
      });
  }, [active, predictionStore, setProject, updateFitRuntime]);

  return {
    calculateDisabled,
    calculateLabel,
    fitInputRef,
    handleCalculatePrediction,
    handleFitInputChange,
    handleUploadFitRequest,
    uploadFitLabel,
  };
}