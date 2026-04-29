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
import {
  buildFitUploadsSignature,
  deserializeLegacyFitUploads,
} from '../lib/persisted-fit-files';
import {
  downloadProjectItineraryFitFiles,
  uploadProjectItineraryFitFiles,
} from '@/lib/projects';
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
  persistedUploadSignature: string;
}

interface PredictionStoreBridge {
  setPrediction: (itineraryId: string, result: PredictionResult | null) => void;
}

interface UseItineraryFitRuntimeArgs {
  active: ItineraryProject['itineraries'][number] | null;
  projectId: string | null;
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
    persistedUploadSignature: '',
  };
}

function mergeFitFiles(existingFiles: readonly File[], incomingFiles: readonly File[]): File[] {
  const merged: File[] = [...existingFiles];
  const seen = new Set(
    existingFiles.map((file) => `${file.name}:${file.lastModified}:${file.size}`),
  );

  for (const file of incomingFiles) {
    const key = `${file.name}:${file.lastModified}:${file.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(file);
  }

  return merged;
}

export function useItineraryFitRuntime({
  active,
  projectId,
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

  useEffect(() => {
    if (!active) return;

    const persistedUploads = active.fitUploads ?? [];
    const persistedUploadSignature = buildFitUploadsSignature(persistedUploads);
    let cancelled = false;

    void (async () => {
      try {
        const legacyFiles = deserializeLegacyFitUploads(
          persistedUploads.filter((upload) => !upload.path && upload.base64),
        );
        const storageUploads = persistedUploads.filter(
          (upload) => typeof upload.path === 'string' && upload.path.length > 0,
        );
        const downloadedFiles = storageUploads.length > 0
          ? await downloadProjectItineraryFitFiles(storageUploads)
          : [];
        if (cancelled) return;

        const downloadedByPath = new Map<string, File>();
        for (let index = 0; index < storageUploads.length; index += 1) {
          const path = storageUploads[index]?.path;
          const file = downloadedFiles[index];
          if (path && file) downloadedByPath.set(path, file);
        }

        const legacyQueue = legacyFiles.slice();
        const fitFiles = persistedUploads.flatMap((upload) => {
          if (upload.path) {
            const file = downloadedByPath.get(upload.path);
            return file ? [file] : [];
          }
          const legacy = legacyQueue.shift();
          return legacy ? [legacy] : [];
        });

        updateFitRuntime(active.id, (current) => {
          const activePrediction = active.prediction ?? null;
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
                : fitFiles;
          const nextFitFileNames = nextFitFiles.map((file) => file.name);
          const sameFitFiles =
            current.fitFiles.length === nextFitFiles.length
            && current.fitFiles.every((file, index) => {
              const nextFile = nextFitFiles[index];
              return (
                file.name === nextFile?.name
                && file.lastModified === nextFile.lastModified
                && file.size === nextFile.size
              );
            });

          if (
            current.persistedUploadSignature === persistedUploadSignature
            && current.predictionResult === activePrediction
            && sameFitFiles
          ) {
            return current;
          }

          return {
            ...current,
            fitFiles: nextFitFiles,
            fitFileNames: nextFitFileNames,
            predictionResult: activePrediction,
            progress: current.status === 'running' ? current.progress : [],
            status:
              current.status === 'running'
                ? current.status
                : activePrediction
                  ? 'success'
                  : nextFitFiles.length > 0
                    ? 'ready'
                    : 'idle',
            error: current.status === 'running' ? current.error : null,
            persistedUploadSignature,
          };
        });
      } catch (error) {
        if (cancelled) return;
        console.error('[fit-predictor] failed to hydrate persisted FIT uploads', error);
        updateFitRuntime(active.id, (current) => {
          if (current.fitFiles.length > 0) {
            return {
              ...current,
              predictionResult: active.prediction ?? null,
              persistedUploadSignature,
            };
          }

          return {
            ...current,
            fitFiles: [],
            fitFileNames: [],
            predictionResult: active.prediction ?? null,
            progress: [],
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Impossible de recharger les fichiers FIT du projet.',
            updatedAt: new Date().toISOString(),
            persistedUploadSignature,
          };
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, projectId, updateFitRuntime]);

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
          status: 'error',
          error: 'Aucun fichier FIT valide sélectionné.',
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      const currentRuntime = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();
      const mergedFitFiles = mergeFitFiles(currentRuntime.fitFiles, fitFiles);

      const persistedUploadSignature = buildFitUploadsSignature(
        mergedFitFiles.map((file) => ({
          name: file.name,
          lastModified: file.lastModified,
          size: file.size,
        })),
      );
      updateFitRuntime(itineraryId, (current) => ({
        ...current,
        fitFiles: mergedFitFiles,
        fitFileNames: mergedFitFiles.map((file) => file.name),
        predictionResult: null,
        progress: [],
        status: 'ready',
        error: null,
        updatedAt: new Date().toISOString(),
        persistedUploadSignature,
      }));

      predictionStore?.setPrediction(itineraryId, null);
      if (!projectId) {
        updateFitRuntime(itineraryId, (current) => ({
          ...current,
          status: 'error',
          error: 'Projet Supabase introuvable pour sauvegarder les FIT.',
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      void uploadProjectItineraryFitFiles(projectId, itineraryId, mergedFitFiles)
        .then((fitUploads) => {
          updateFitRuntime(itineraryId, (current) => ({
            ...current,
            persistedUploadSignature: buildFitUploadsSignature(fitUploads),
          }));
          setProject((prev) => ({
            ...prev,
            itineraries: prev.itineraries.map((current) =>
              current.id === itineraryId
                ? {
                    ...current,
                    fitUploads,
                    prediction: null,
                    pendingFitRecompute: undefined,
                    metrics: current.metrics
                      ? {
                          ...current.metrics,
                          durationSec: undefined,
                        }
                      : current.metrics,
                  }
                : current,
            ),
          }));
        })
        .catch((error: unknown) => {
          console.error('[fit-predictor] failed to persist FIT uploads', error);
          updateFitRuntime(itineraryId, (current) => ({
            ...current,
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Impossible de sauvegarder les fichiers FIT dans le bucket du projet.',
            updatedAt: new Date().toISOString(),
          }));
        });
    },
    [predictionStore, projectId, setProject, updateFitRuntime],
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
            ? 'Le profil altimetrique du trace BRouter n\'est pas encore pret. Relancez le calcul quand le trace est charge.'
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
        setProject((prev) => ({
          ...prev,
          itineraries: prev.itineraries.map((curr) =>
            curr.id === itineraryId
              ? {
                  ...curr,
                  pendingFitRecompute: undefined,
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
              ? error.message
              : 'Erreur inconnue pendant la prediction FIT.',
          updatedAt: new Date().toISOString(),
        }));
        predictionStore?.setPrediction(itineraryId, null);
      });
  }, [active, predictionStore, setProject, updateFitRuntime]);

  useEffect(() => {
    if (!active || active.pendingFitRecompute !== true) return;

    const runtime = fitRuntimeRef.current[active.id] ?? createEmptyFitRuntime();
    if (runtime.status === 'running') return;

    if (runtime.fitFiles.length === 0) {
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((curr) =>
          curr.id === active.id
            ? {
                ...curr,
                pendingFitRecompute: undefined,
              }
            : curr,
        ),
      }));
      return;
    }

    if (!active.gpxRoute || active.gpxRoute.points.length < 2) return;
    if (active.gpxRoute.source === 'brouter' && !active.routeAudit) return;
    if (!hasUsableRouteElevation(active.gpxRoute.points)) return;

    handleCalculatePrediction();
  }, [active, activeRouteSignature, handleCalculatePrediction, setProject]);

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