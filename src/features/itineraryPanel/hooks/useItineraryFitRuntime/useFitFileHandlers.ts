import { countBucket, trackAnalyticsEvent } from '@/shared/lib/analytics';
import { useCallback, useRef, type ChangeEvent, type Dispatch, type SetStateAction } from 'react';
import { translateAppText } from '@/shared/i18n';
import { appwriteFailureMessage } from '@/shared/lib/appwriteErrors';
import { ensureHealthDataConsent, runWithHealthDataConsent } from '@/shared/services/healthDataConsent';
import { deleteFitUploads, uploadProjectItineraryFitFiles } from '@/shared/services/projects';
import { validateFitFile, type FitFileProblem } from '@/features/fitPredictor/lib/fitFileValidation';
import { buildFitUploadsSignature } from '../../lib/schedule';
import { MAX_FIT_FILES } from '../../lib/rhythm/profile';
import type { Itinerary, ItineraryFitUpload, ItineraryProject } from '../../types';
import { buildLocalFitUploadSignature, fitFileKey, planFitSelection } from './files';
import { buildRejectedFitNotice } from './labels';
import {
  createEmptyFitRuntime,
  type FitRuntimeRef,
  type PredictionStoreBridge,
  type UpdateFitRuntime,
} from './types';

interface UseFitFileHandlersArgs {
  active: Itinerary | null;
  projectId: string | null;
  predictionStore: PredictionStoreBridge | null;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  fitRuntimeRef: FitRuntimeRef;
  updateFitRuntime: UpdateFitRuntime;
}

/**
 * Ajout (sélecteur de fichiers, contrôle d'en-tête, envoi des seuls nouveaux
 * fichiers) et retrait des .fit d'un itinéraire, avec suppression du bucket.
 */
export function useFitFileHandlers({
  active,
  projectId,
  predictionStore,
  setProject,
  fitRuntimeRef,
  updateFitRuntime,
}: UseFitFileHandlersArgs) {
  const fitInputRef = useRef<HTMLInputElement | null>(null);
  const fitUploadTargetIdRef = useRef<string | null>(null);

  const handleUploadFitRequest = useCallback(() => {
    if (!active) return;
    const targetId = active.id;
    // Données de santé (RGPD art. 9) : accord explicite avant d'ouvrir le
    // sélecteur. input.click() exige un geste de l'utilisateur, que WebKit
    // perd après ~1 s d'attente réseau : le sélecteur s'ouvre dans le clic
    // même (accord connu) ou dans celui sur « J'accepte » (A10-2). Les
    // fichiers choisis ne sont lus qu'une fois l'accord confirmé
    // (handleFitInputChange).
    runWithHealthDataConsent(() => {
      fitUploadTargetIdRef.current = targetId;
      if (fitInputRef.current) {
        fitInputRef.current.value = '';
        fitInputRef.current.click();
      }
    });
  }, [active]);

  const handleFitInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const itineraryId = fitUploadTargetIdRef.current ?? active?.id;
      if (!itineraryId) return;

      const selected = Array.from(event.target.files ?? []);
      if (selected.length === 0) return;
      // Le sélecteur a pu s'ouvrir avant que l'accord soit écrit dans le
      // compte, ou sur un accord retiré depuis sur un autre appareil : aucun
      // fichier n'est lu sans accord confirmé.
      if (!(await ensureHealthDataConsent())) return;

      // L'extension ne suffit pas (GPX renommé, fichier vide ou tronqué) : un
      // seul fichier illisible faisait échouer toute la prédiction, et
      // persisté, après chaque rechargement. Un fichier d'une autre extension
      // est nommé comme refusé (il était écarté sans un mot).
      const problems = await Promise.all(
        selected.map((file) =>
          file.name.toLowerCase().endsWith('.fit')
            ? validateFitFile(file).catch((): FitFileProblem => 'not-fit')
            : Promise.resolve<FitFileProblem>('not-fit'),
        ),
      );
      const current = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();
      const { nextFitFiles, added, rejected, overLimit } = planFitSelection(
        current.fitFiles,
        selected,
        problems,
        MAX_FIT_FILES,
      );
      const rejectedNotice = [
        rejected.length > 0 ? buildRejectedFitNotice(rejected) : null,
        overLimit.length > 0
          ? translateAppText('Limite de {{count}} fichiers .fit : {{list}} non ajoutés.', {
              count: MAX_FIT_FILES,
              list: overLimit.map((file) => file.name).join(', '),
            })
          : null,
      ].filter(Boolean).join(' ') || null;
      // Rien de neuf (refusés, doublons, limite atteinte) : pas d'envoi ni de
      // nouveau calcul de la prédiction.
      if (added === 0) {
        updateFitRuntime(itineraryId, (prev) => ({ ...prev, uploadNotice: rejectedNotice }));
        return;
      }
      trackAnalyticsEvent({ name: 'fit_uploaded', data: { files: countBucket(added) } });

      const nextFitFileNames = nextFitFiles.map((file) => file.name);
      const localSignature = buildLocalFitUploadSignature(nextFitFiles);

      updateFitRuntime(itineraryId, (prev) => ({
        ...prev,
        fitFiles: nextFitFiles,
        fitFileNames: nextFitFileNames,
        status: 'ready',
        error: null,
        uploadNotice: rejectedNotice,
        persistedUploadSignature: localSignature,
      }));

      if (!projectId) return;

      // N'envoyer que les fichiers pas encore enregistrés : renvoyer toute la
      // liste à chaque ajout dupliquait les fichiers du bucket sous de
      // nouveaux ids (traces GPS personnelles jamais supprimées).
      const existingUploads = active?.id === itineraryId ? active.fitUploads ?? [] : [];
      const nextKeys = new Set(nextFitFiles.map(fitFileKey));
      const keptUploads = existingUploads.filter((upload) => nextKeys.has(fitFileKey(upload)));
      const keptUploadKeys = new Set(keptUploads.map(fitFileKey));
      const filesToUpload = nextFitFiles.filter((file) => !keptUploadKeys.has(fitFileKey(file)));
      // Uploads du projet que cet appareil n'a pas chargés (illisibles ici dans
      // un projet partagé, téléchargement échoué) : gardés tels quels. Reconstruite
      // à partir des seuls fichiers chargés, la liste les effaçait du projet.
      const unloadedUploads = unloadedFitUploads(existingUploads, current.fitFiles)
        .filter((upload) => !nextKeys.has(fitFileKey(upload)));

      try {
        const { uploads: newUploads, failed } = filesToUpload.length > 0
          ? await uploadProjectItineraryFitFiles(projectId, itineraryId, filesToUpload)
          : { uploads: [], failed: [] };
        // Ordre de la liste locale, uploads existants réutilisés tels quels.
        const uploadByKey = new Map(
          [...keptUploads, ...newUploads].map((upload) => [fitFileKey(upload), upload]),
        );
        const storedUploads = [
          ...nextFitFiles.flatMap((file) => {
            const upload = uploadByKey.get(fitFileKey(file));
            return upload ? [upload] : [];
          }),
          ...unloadedUploads,
        ];

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
          uploadNotice: [
            rejectedNotice,
            failed.length > 0
              ? translateAppText(
                  'Envoi impossible pour : {{list}}. Ces fichiers sont utilisés mais ne seront pas conservés dans le projet.',
                  { list: failed.map((file) => file.name).join(', ') },
                )
              : null,
          ].filter(Boolean).join(' ') || null,
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
                    // FTP conservée telle quelle : la valeur par défaut est
                    // null (FTP virtuelle des .fit), une FTP non nulle a été
                    // saisie par l'utilisateur — l'ancienne remise à null de
                    // 260 / 300 effaçait une saisie réelle.
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
          // Jamais le message anglais d'Appwrite, écrit pour un développeur.
          error: translateAppText(
            appwriteFailureMessage(error, 'Impossible de sauvegarder les fichiers FIT sur le serveur.'),
          ),
          uploadNotice: translateAppText('Impossible de sauvegarder les fichiers FIT sur le serveur.'),
          updatedAt: new Date().toISOString(),
        }));
      }
    },
    [active, fitRuntimeRef, predictionStore, projectId, setProject, updateFitRuntime],
  );

  const handleRemoveFitFiles = useCallback(
    (shouldRemove: (index: number) => boolean) => {
      const itinerary = active;
      if (!itinerary) return;
      const itineraryId = itinerary.id;

      const current = fitRuntimeRef.current[itineraryId] ?? createEmptyFitRuntime();
      const nextFitFiles = current.fitFiles.filter((_, index) => !shouldRemove(index));
      if (nextFitFiles.length === current.fitFiles.length) return;

      // Seuls les uploads des fichiers retirés quittent le projet ; la signature
      // est alignée sur la liste restante pour que l'hydratation réutilise les
      // fichiers déjà en mémoire au lieu de les re-télécharger. Un upload que
      // cet appareil n'a pas chargé (illisible ici dans un projet partagé,
      // téléchargement échoué) reste : il était effacé du projet, et du bucket.
      const keptKeys = new Set(nextFitFiles.map(fitFileKey));
      const removedKeys = new Set(
        current.fitFiles.filter((file) => !keptKeys.has(fitFileKey(file))).map(fitFileKey),
      );
      const uploads = itinerary.fitUploads ?? [];
      const nextUploads = uploads.filter((upload) => !removedKeys.has(fitFileKey(upload)));
      const uploadedKeys = new Set(nextUploads.map(fitFileKey));
      // RGPD : un .fit retiré est supprimé du bucket. Un « annuler » qui le
      // remettrait dans le projet ne retrouverait plus le fichier :
      // l'hydratation le retire alors proprement (404 → missingFileIds).
      const removedUploads = uploads.filter((upload) => removedKeys.has(fitFileKey(upload)));
      if (removedUploads.length > 0) {
        void deleteFitUploads(removedUploads);
      }

      updateFitRuntime(itineraryId, (prev) => ({
        ...prev,
        fitFiles: nextFitFiles,
        fitFileNames: nextFitFiles.map((file) => file.name),
        status: prev.status === 'running' ? prev.status : nextFitFiles.length > 0 ? 'ready' : 'idle',
        error: null,
        // Plus aucun fichier local non enregistré : l'avertissement d'envoi tombe.
        uploadNotice: nextFitFiles.every((file) => uploadedKeys.has(fitFileKey(file)))
          ? null
          : prev.uploadNotice,
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
    [active, fitRuntimeRef, predictionStore, setProject, updateFitRuntime],
  );

  const handleRemoveFitFile = useCallback(
    (index: number) => handleRemoveFitFiles((candidate) => candidate === index),
    [handleRemoveFitFiles],
  );

  const handleClearFitFiles = useCallback(
    () => handleRemoveFitFiles(() => true),
    [handleRemoveFitFiles],
  );

  return {
    fitInputRef,
    handleUploadFitRequest,
    handleFitInputChange,
    handleRemoveFitFile,
    handleClearFitFiles,
  };
}

/** Uploads persistés dont aucun fichier n'est en mémoire sur cet appareil. */
function unloadedFitUploads(
  uploads: readonly ItineraryFitUpload[],
  loadedFiles: readonly File[],
): ItineraryFitUpload[] {
  const loadedKeys = new Set(loadedFiles.map(fitFileKey));
  return uploads.filter((upload) => !loadedKeys.has(fitFileKey(upload)));
}
