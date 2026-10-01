import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  FitPredictionCancelledError,
  createFitPredictionEngine,
} from '@/features/fitPredictor/engine/api';
import type { PredictionResult } from '@/features/fitPredictor';
import type { Itinerary } from '../../types';
import {
  uploadProjectItineraryFitFiles,
} from '@/shared/utils/projects';

import {
  buildPredictionConfigFromRhythm,
  buildRunPredictionConfigFromRhythm,
  buildRouteGpxFile,
  hasUsableRouteElevation,
} from '../../lib/schedule';
import {
  isFootDiscipline,
  normalizeDiscipline,
  resolvePredictionDiscipline,
} from '@/shared/lib/discipline';
import { buildPauseAwareSchedule } from '../../lib/schedule';
import { buildFitUploadsSignature } from '../../lib/schedule';
import { MAX_FIT_FILES, isCustomRhythmProfile } from '../../lib/rhythm/profile';

import {
  buildLocalFitUploadSignature,
  fitFileKey,
  fitFilesEqual,
  mergeFitFiles,
} from './files';
import { hydratePersistedFitRuntime } from './hydration';
import { buildFitStatusText } from './labels';
import { translateAppText } from '@/shared/i18n';
import {
  createEmptyFitRuntime,
  type ItineraryFitRuntime,
  type UseItineraryFitRuntimeArgs,
} from './types';

type RoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

const EMPTY_FIT_FILE_NAMES: string[] = [];

function buildRouteSignature(points: RoutePoints | null | undefined): string {
  if (!points || points.length < 2) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return [
    points.length,
    first ? `${first.lon.toFixed(5)},${first.lat.toFixed(5)}` : '',
    last ? `${last.lon.toFixed(5)},${last.lat.toFixed(5)}` : '',
    last?.distanceM ?? '',
  ].join('|');
}

/** Entrées d'une prédiction : un résultat n'est valable que pour elles. */
function buildPredictionInputSignature(itinerary: Itinerary): string {
  return [
    buildRouteSignature(itinerary.gpxRoute?.points),
    normalizeDiscipline(itinerary.discipline),
    JSON.stringify(itinerary.rhythm ?? null),
  ].join('::');
}

export function useItineraryFitRuntime({
  active,
  projectId,
  predictionStore,
  setProject,
}: UseItineraryFitRuntimeArgs) {
  const fitInputRef = useRef<HTMLInputElement | null>(null);
  const fitUploadTargetIdRef = useRef<string | null>(null);
  const latestPredictionRunRef = useRef<Record<string, number>>({});
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
  const activeRouteSignature = useMemo(
    () => buildRouteSignature(active?.gpxRoute?.points),
    [active?.gpxRoute?.points],
  );
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

  const activeDiscipline = normalizeDiscipline(active?.discipline);

  const activeCalculationSignature = useMemo(() => {
    if (!active || !activeRouteSignature) return '';
    return `${active.id}::${activeDiscipline}::${activeRouteSignature}::${activeRhythmSignature}::${activePersistedUploadSignature}`;
  }, [active, activeDiscipline, activeRouteSignature, activeRhythmSignature, activePersistedUploadSignature]);

  const fitStatusText = useMemo(
    () => buildFitStatusText(activeFitRuntime),
    [activeFitRuntime],
  );

  const calculateLabel = useMemo(() => {
    if (fitStatusText) return fitStatusText;
    return translateAppText('Calculer');
  }, [fitStatusText]);

  const calculateDisabled = activeFitRuntime?.status === 'running';
  const calculateError =
    (activeFitRuntime?.status === 'error' ? activeFitRuntime.error : null)
    ?? activeFitRuntime?.uploadError
    ?? null;
  const fitFileNames = activeFitRuntime?.fitFileNames ?? EMPTY_FIT_FILE_NAMES;

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

        if (hydrated.missingFileIds && hydrated.missingFileIds.length > 0) {
          setProject((prev) => ({
            ...prev,
            itineraries: prev.itineraries.map((it) =>
              it.id === itineraryId
                ? {
                    ...it,
                    fitUploads: (it.fitUploads ?? []).filter(
                      (u) => !hydrated.missingFileIds?.includes(u.path ?? ''),
                    ),
                  }
                : it,
            ),
          }));
        }

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
      const nextFitFiles = mergeFitFiles(current.fitFiles, incoming).slice(0, MAX_FIT_FILES);
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
        const { uploads: storedUploads, failed } = await uploadProjectItineraryFitFiles(
          projectId,
          itineraryId,
          nextFitFiles,
        );

        // Les fichiers non envoyés restent dans l'état local (toujours utilisés
        // pour la prédiction) ; la signature suit les uploads persistés pour
        // que l'hydratation réutilise les fichiers en mémoire au lieu de les
        // remplacer par la liste partielle téléchargée.
        updateFitRuntime(itineraryId, (prev) => ({
          ...prev,
          persistedUploadSignature:
            storedUploads.length > 0
              ? buildFitUploadsSignature(storedUploads)
              : buildLocalFitUploadSignature(prev.fitFiles),
          uploadError:
            failed.length > 0
              ? translateAppText(
                  'Envoi impossible pour : {{list}}. Ces fichiers sont utilisés mais ne seront pas conservés dans le projet.',
                  { list: failed.map((file) => file.name).join(', ') },
                )
              : null,
        }));

        setProject((prev) => {
          const nextItineraries = prev.itineraries.map((it) =>
            it.id === itineraryId
              ? {
                  ...it,
                  rhythm: {
                    ...it.rhythm,
                    usePastActivities: true,
                    rhythmProfile: 'custom' as const,
                    // Clear hardcoded default FTP so .fit files' virtual FTP is automatically used
                    ftp: it.rhythm.ftp === 260 || it.rhythm.ftp === 300 ? null : it.rhythm.ftp,
                  },
                  fitUploads: storedUploads,
                  rhythmConfigured: true,
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
          uploadError: translateAppText('Impossible de sauvegarder les fichiers FIT sur le serveur.'),
          updatedAt: new Date().toISOString(),
        }));
      }
    },
    [active?.id, predictionStore, projectId, setProject, updateFitRuntime],
  );

  const handleRemoveFitFiles = useCallback(
    (shouldRemove: (index: number) => boolean) => {
      const itinerary = active;
      if (!itinerary) return;
      const itineraryId = itinerary.id;

      const current = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();
      const nextFitFiles = current.fitFiles.filter((_, index) => !shouldRemove(index));
      if (nextFitFiles.length === current.fitFiles.length) return;

      // Les uploads persistés suivent les fichiers conservés ; la signature est
      // alignée dessus pour que l'hydratation réutilise les fichiers déjà en
      // mémoire au lieu de les re-télécharger.
      const keptKeys = new Set(nextFitFiles.map(fitFileKey));
      const nextUploads = (itinerary.fitUploads ?? []).filter((upload) =>
        keptKeys.has(fitFileKey(upload)),
      );
      const uploadedKeys = new Set(nextUploads.map(fitFileKey));

      updateFitRuntime(itineraryId, (prev) => ({
        ...prev,
        fitFiles: nextFitFiles,
        fitFileNames: nextFitFiles.map((file) => file.name),
        status: prev.status === 'running' ? prev.status : nextFitFiles.length > 0 ? 'ready' : 'idle',
        error: null,
        // Plus aucun fichier local non enregistré : l'avertissement d'envoi tombe.
        uploadError: nextFitFiles.every((file) => uploadedKeys.has(fitFileKey(file)))
          ? null
          : prev.uploadError,
        // Sans upload persisté (projet non enregistré), signature locale comme
        // à l'ajout, sinon l'hydratation viderait les fichiers restants.
        persistedUploadSignature:
          nextUploads.length > 0
            ? buildFitUploadsSignature(nextUploads)
            : buildLocalFitUploadSignature(nextFitFiles),
      }));

      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) =>
          it.id === itineraryId
            ? {
                ...it,
                fitUploads: nextUploads,
                rhythmConfigured: true,
                prediction: undefined,
                pendingFitRecompute: true,
              }
            : it,
        ),
      }));
      predictionStore?.setPrediction(itineraryId, null);
    },
    [active, predictionStore, setProject, updateFitRuntime],
  );

  const handleRemoveFitFile = useCallback(
    (index: number) => handleRemoveFitFiles((candidate) => candidate === index),
    [handleRemoveFitFiles],
  );

  const handleClearFitFiles = useCallback(
    () => handleRemoveFitFiles(() => true),
    [handleRemoveFitFiles],
  );

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
    const gpxFile = buildRouteGpxFile(itinerary);
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
    // Les .fit ne comptent qu'en profil "Personalisé".
    const fitFiles = isCustomRhythmProfile(itinerary.rhythm) ? runtime.fitFiles : [];
    const pending = isFootDiscipline(discipline)
      ? engine.predictRun(
          fitFiles,
          gpxFile,
          buildRunPredictionConfigFromRhythm(itinerary.rhythm, discipline, routePoints),
          onProgress,
          { key: itineraryId },
        )
      : engine.predict(
          fitFiles,
          gpxFile,
          buildPredictionConfigFromRhythm(itinerary.rhythm, routePoints),
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
  }, [active, predictionStore, updateFitRuntime]);

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

      if (active.prediction && !isDistMismatched && !isDisciplineMismatched) {
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
    handleCalculatePrediction,
    predictionStore,
    setProject,
    updateFitRuntime,
  ]);

  return {
    calculateDisabled,
    calculateError,
    calculateLabel,
    cancelCalculatePrediction,
    fitFileNames,
    fitInputRef,
    handleCalculatePrediction,
    handleClearFitFiles,
    handleFitInputChange,
    handleRemoveFitFile,
    handleUploadFitRequest,
  };
}