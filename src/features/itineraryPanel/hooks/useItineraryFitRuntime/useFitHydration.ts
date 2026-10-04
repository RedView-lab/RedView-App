import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import { translateAppText } from '@/shared/i18n';
import type { Itinerary, ItineraryFitUpload, ItineraryProject } from '../../types';
import { fitFileKey, fitFilesEqual } from './files';
import { hydratePersistedFitRuntime } from './hydration';
import {
  createEmptyFitRuntime,
  type ExcludeFitFiles,
  type FitRuntimeRef,
  type ItineraryFitRuntime,
  type UpdateFitRuntime,
} from './types';

interface UseFitHydrationArgs {
  active: Itinerary | null;
  hydrationInput: { fitUploads: ItineraryFitUpload[]; prediction: PredictionResult | null } | null;
  persistedUploadSignature: string;
  activePrediction: PredictionResult | null;
  fitRuntimeRef: FitRuntimeRef;
  updateFitRuntime: UpdateFitRuntime;
  excludeFitFiles: ExcludeFitFiles;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

/**
 * Recharge les .fit enregistrés de l'itinéraire actif (bucket) dans l'état
 * local : uploads introuvables retirés du projet, fichiers illisibles écartés,
 * un échec n'est pas retenté tant que la liste persistée ne change pas.
 */
export function useFitHydration({
  active,
  hydrationInput: activeFitHydrationInput,
  persistedUploadSignature: activePersistedUploadSignature,
  activePrediction,
  fitRuntimeRef,
  updateFitRuntime,
  excludeFitFiles,
  setProject,
}: UseFitHydrationArgs): void {
  const failedHydrationSignatureRef = useRef<Record<string, string>>({});

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

    // Fichiers déjà en mémoire pour cette liste persistée (ajout de la session,
    // hydratation précédente) ou fichiers locaux non enregistrés : rien à
    // télécharger, seule la prédiction chargée est reportée. Sans ce raccourci,
    // chaque nouvelle prédiction re-téléchargeait tous les .fit du bucket.
    if (holdsPersistedFiles(currentRuntime, activeFitHydrationInput.fitUploads, persistedUploadSignature)) {
      const predictionResult = activeFitHydrationInput.prediction ?? null;
      updateFitRuntime(itineraryId, (current) => {
        if (current.predictionResult === predictionResult) return current;
        return {
          ...current,
          predictionResult,
          status:
            current.status === 'running'
              ? current.status
              : predictionResult
                ? 'success'
                : current.fitFiles.length > 0
                  ? 'ready'
                  : 'idle',
        };
      });
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
            // Fichiers locaux gardés : leur signature aussi. Remise à « vide »,
            // l'hydratation suivante (nouvelle prédiction) ne les reconnaissait
            // plus et vidait la liste.
            persistedUploadSignature: shouldPreserveLocalFiles
              ? current.persistedUploadSignature
              : hydrated.persistedUploadSignature,
          };
        });

        if (hydrated.invalidUploads) {
          excludeFitFiles(
            itineraryId,
            activeFitHydrationInput.fitUploads,
            hydrated.invalidUploads.map(({ upload, problem }) => ({ file: upload, reason: problem })),
            false,
          );
        }
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
  }, [active?.id, activeFitHydrationInput, activePersistedUploadSignature, activePrediction, excludeFitFiles, fitRuntimeRef, setProject, updateFitRuntime]);
}

/**
 * Vrai quand l'état local tient déjà les .fit de la liste persistée (chacun
 * présent en mémoire), ou des .fit locaux que le projet n'a pas (projet non
 * enregistré, envoi échoué, uploads disparus du bucket).
 */
function holdsPersistedFiles(
  runtime: ItineraryFitRuntime,
  uploads: readonly ItineraryFitUpload[],
  persistedUploadSignature: string,
): boolean {
  if (runtime.fitFiles.length === 0) return false;
  if (persistedUploadSignature.length === 0) return runtime.persistedUploadSignature.length > 0;
  if (runtime.persistedUploadSignature !== persistedUploadSignature) return false;
  const loadedKeys = new Set(runtime.fitFiles.map(fitFileKey));
  return uploads.every((upload) => loadedKeys.has(fitFileKey(upload)));
}
