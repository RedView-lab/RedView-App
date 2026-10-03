import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PredictionResult } from '@/features/fitPredictor';
import { translateAppText } from '@/shared/i18n';
import type { Itinerary, ItineraryFitUpload, ItineraryProject } from '../../types';
import { fitFilesEqual } from './files';
import { hydratePersistedFitRuntime } from './hydration';
import {
  createEmptyFitRuntime,
  type ExcludeFitFiles,
  type FitRuntimeRef,
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
