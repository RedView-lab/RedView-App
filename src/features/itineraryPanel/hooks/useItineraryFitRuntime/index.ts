import {
  useCallback,
  useMemo,
  useState,
} from 'react';

import { deleteFitUploads } from '@/shared/utils/projects';
import { useKeyedValue } from '@/shared/hooks/useKeyedValue';
import { useLatestRef } from '@/shared/hooks/useLatestRef';
import { normalizeDiscipline } from '@/shared/lib/discipline';
import { translateAppText } from '@/shared/i18n';
import { buildFitUploadsSignature } from '../../lib/schedule';
import { buildLocalFitUploadSignature, fitFileKey } from './files';
import { buildFitStatusText, buildRejectedFitNotice } from './labels';
import { buildRouteSignature } from './signatures';
import { useAutoPrediction } from './useAutoPrediction';
import { useFitFileHandlers } from './useFitFileHandlers';
import { useFitHydration } from './useFitHydration';
import { usePredictionRun } from './usePredictionRun';
import {
  createEmptyFitRuntime,
  type ExcludeFitFiles,
  type ItineraryFitRuntime,
  type UpdateFitRuntime,
  type UseItineraryFitRuntimeArgs,
} from './types';

const EMPTY_FIT_FILE_NAMES: string[] = [];

/**
 * Prédiction de temps de l'itinéraire actif et ses .fit : état d'exécution par
 * itinéraire, fichiers (hydratation, ajout, retrait), calcul et recalcul auto.
 */
export function useItineraryFitRuntime({
  active,
  projectId,
  predictionStore,
  setProject,
}: UseItineraryFitRuntimeArgs) {
  const [fitRuntimeByItineraryId, setFitRuntimeByItineraryId] = useState<
    Record<string, ItineraryFitRuntime>
  >({});
  // Lu par les gestionnaires et les calculs asynchrones : l'état du dernier rendu validé.
  const fitRuntimeRef = useLatestRef(fitRuntimeByItineraryId);

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
  // Même objet tant que l'itinéraire, la liste persistée (par sa signature)
  // et la prédiction ne changent pas : son identité relance l'hydratation, qui
  // annulerait et retéléchargerait les .fit à chaque nouveau tableau d'uploads.
  const activeFitHydrationInput = useKeyedValue(
    active
      ? {
          fitUploads: active.fitUploads ?? [],
          prediction: activePrediction,
        }
      : null,
    [active?.id, activePersistedUploadSignature, activePrediction],
  );

  const activeRhythm = active?.rhythm;
  const activeRhythmSignature = useMemo(
    () => (activeRhythm ? JSON.stringify(activeRhythm) : ''),
    [activeRhythm],
  );

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
  // Seul un échec de calcul masque le résultat : un fichier écarté ou non
  // enregistré est signalé à part (`fitNotice`). Les confondre cachait le
  // résultat du recalcul réussi juste après l'exclusion d'un .fit.
  const calculateError = activeFitRuntime?.status === 'error' ? activeFitRuntime.error : null;
  const fitNotice = activeFitRuntime?.uploadNotice ?? null;
  const fitFileNames = activeFitRuntime?.fitFileNames ?? EMPTY_FIT_FILE_NAMES;

  const updateFitRuntime = useCallback<UpdateFitRuntime>(
    (itineraryId, mut) => {
      setFitRuntimeByItineraryId((prev) => {
        const current = prev[itineraryId] ?? createEmptyFitRuntime();
        const next = mut(current);
        if (next === current) return prev;
        return { ...prev, [itineraryId]: next };
      });
    },
    [],
  );

  /**
   * Écarte des .fit inexploitables : retirés de l'état local et du projet,
   * supprimés du bucket, et signalés par nom. `recompute` relance la
   * prédiction sans eux.
   */
  const excludeFitFiles = useCallback<ExcludeFitFiles>(
    (itineraryId, uploadsSnapshot, rejected, recompute) => {
      if (rejected.length === 0) return;
      const keys = new Set(rejected.map(({ file }) => fitFileKey(file)));
      const remainingUploads = uploadsSnapshot.filter((upload) => !keys.has(fitFileKey(upload)));
      const removedUploads = uploadsSnapshot.filter((upload) => keys.has(fitFileKey(upload)));
      if (removedUploads.length > 0) void deleteFitUploads(removedUploads);
      const notice = buildRejectedFitNotice(rejected);

      updateFitRuntime(itineraryId, (prev) => {
        const fitFiles = prev.fitFiles.filter((file) => !keys.has(fitFileKey(file)));
        return {
          ...prev,
          fitFiles,
          fitFileNames: fitFiles.map((file) => file.name),
          // Cumulé : plusieurs refus successifs restent tous nommés.
          uploadNotice: prev.uploadNotice && !prev.uploadNotice.includes(notice)
            ? `${prev.uploadNotice} ${notice}`
            : notice,
          persistedUploadSignature:
            remainingUploads.length > 0
              ? buildFitUploadsSignature(remainingUploads)
              : buildLocalFitUploadSignature(fitFiles),
        };
      });
      setProject((prev) => ({
        ...prev,
        itineraries: prev.itineraries.map((it) => {
          if (it.id !== itineraryId) return it;
          const fitUploads = (it.fitUploads ?? []).filter((upload) => !keys.has(fitFileKey(upload)));
          return recompute
            ? { ...it, fitUploads, prediction: undefined, pendingFitRecompute: true }
            : { ...it, fitUploads };
        }),
      }));
    },
    [setProject, updateFitRuntime],
  );

  useFitHydration({
    active,
    hydrationInput: activeFitHydrationInput,
    persistedUploadSignature: activePersistedUploadSignature,
    activePrediction,
    fitRuntimeRef,
    updateFitRuntime,
    excludeFitFiles,
    setProject,
  });

  const {
    fitInputRef,
    handleUploadFitRequest,
    handleFitInputChange,
    handleRemoveFitFile,
    handleClearFitFiles,
  } = useFitFileHandlers({ active, projectId, predictionStore, setProject, fitRuntimeRef, updateFitRuntime });

  const { handleCalculatePrediction, cancelCalculatePrediction } = usePredictionRun({
    active,
    predictionStore,
    setProject,
    fitRuntimeRef,
    updateFitRuntime,
    excludeFitFiles,
  });

  useAutoPrediction({
    active,
    activeCalculationSignature,
    activeDiscipline,
    handleCalculatePrediction,
    predictionStore,
    setProject,
    fitRuntimeRef,
    updateFitRuntime,
  });

  return {
    calculateDisabled,
    calculateError,
    calculateLabel,
    cancelCalculatePrediction,
    fitFileNames,
    fitNotice,
    fitInputRef,
    handleCalculatePrediction,
    handleClearFitFiles,
    handleFitInputChange,
    handleRemoveFitFile,
    handleUploadFitRequest,
  };
}
