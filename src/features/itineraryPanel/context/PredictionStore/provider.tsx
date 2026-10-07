import { useCallback, useMemo, useState, type ReactNode } from 'react';

import type { PredictionResult } from '@/features/fitPredictor';
import { useProjectStoreOptional } from '../ProjectStore';
import { PredictionStoreContext, type PredictionStoreValue } from './context';
import { followProjectPredictions, projectPredictions, type PredictionMap } from './projectPredictions';

interface PredictionProviderProps {
  children: ReactNode;
}

/**
 * Holds the latest FIT prediction per itinerary so non-itinerary panels
 * (center analysis chart, etc.) can read prediction time-series without
 * having to be wired through props or duplicate the worker call.
 *
 * Predictions are also mirrored into the project store so the Dashboard
 * autosaver persists them to Appwrite. On mount we hydrate from any
 * predictions previously saved on the project itineraries — that way the
 * analysis chart instantly re-appears when reopening a saved project.
 */
export function PredictionProvider({ children }: PredictionProviderProps) {
  const projectStore = useProjectStoreOptional();
  const itineraries = projectStore?.project.itineraries;

  // Lazy-initialise from any predictions persisted on the project. The
  // Dashboard remounts the provider with a fresh `key` whenever the user
  // opens a different project, so we always start from the loaded payload.
  const [predictions, setPredictions] = useState<PredictionMap>(() => projectPredictions(itineraries));

  // Le projet fait foi (followProjectPredictions) : suivi pendant le rendu,
  // dès que ses itinéraires changent — pas d'image intermédiaire où un undo
  // afficherait encore la prédiction de l'état quitté.
  const [followedItineraries, setFollowedItineraries] = useState(itineraries);
  if (itineraries !== followedItineraries) {
    setFollowedItineraries(itineraries);
    if (itineraries) {
      setPredictions((current) => followProjectPredictions(current, followedItineraries, itineraries));
    }
  }

  const setPrediction = useCallback(
    (itineraryId: string, result: PredictionResult | null) => {
      setPredictions((prev) => {
        if (result === null) {
          if (!(itineraryId in prev)) return prev;
          const next = { ...prev };
          delete next[itineraryId];
          return next;
        }
        if (prev[itineraryId] === result) return prev;
        return { ...prev, [itineraryId]: result };
      });
      // Mirror into the project so the Dashboard autosaver pushes the
      // prediction to Appwrite. Derived data: written outside undo history.
      const setProjectWithoutHistory = projectStore?.setProjectWithoutHistory;
      if (setProjectWithoutHistory) {
        setProjectWithoutHistory((project) => {
          const target = project.itineraries.find((it) => it.id === itineraryId);
          if (!target || (target.prediction ?? null) === result) return project;
          return {
            ...project,
            itineraries: project.itineraries.map((it) =>
              it.id === itineraryId ? { ...it, prediction: result } : it,
            ),
          };
        });
      }
    },
    [projectStore?.setProjectWithoutHistory],
  );

  const clearPredictions = useCallback(() => {
    setPredictions((prev) => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  const value = useMemo<PredictionStoreValue>(
    () => ({ predictions, setPrediction, clearPredictions }),
    [predictions, setPrediction, clearPredictions],
  );

  return (
    <PredictionStoreContext.Provider value={value}>
      {children}
    </PredictionStoreContext.Provider>
  );
}
