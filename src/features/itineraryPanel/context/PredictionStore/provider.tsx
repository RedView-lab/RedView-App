import { useCallback, useMemo, useState, type ReactNode } from 'react';

import type { PredictionResult } from '@/features/fitPredictor';
import { useProjectStoreOptional } from '../ProjectStore';
import { PredictionStoreContext, type PredictionStoreValue } from './context';
import { followProjectPredictions, projectPredictions, type PredictionMap } from './projectPredictions';

interface PredictionProviderProps {
  children: ReactNode;
}

/**
 * Garde la dernière prédiction FIT par itinéraire pour que les panneaux hors
 * itinéraire (graphique d'analyse central, etc.) puissent lire les séries
 * temporelles de prédiction sans passer par les props ni dupliquer l'appel au worker.
 *
 * Les prédictions sont aussi recopiées dans le store de projet pour que
 * l'enregistrement automatique du Dashboard les persiste dans Appwrite. Au
 * montage, on hydrate depuis les prédictions déjà enregistrées sur les
 * itinéraires du projet — le graphique d'analyse réapparaît ainsi
 * instantanément à la réouverture d'un projet enregistré.
 */
export function PredictionProvider({ children }: PredictionProviderProps) {
  const projectStore = useProjectStoreOptional();
  const itineraries = projectStore?.project.itineraries;

  // Initialisation paresseuse depuis les prédictions persistées sur le projet.
  // Le Dashboard remonte le provider avec une `key` neuve chaque fois que
  // l'utilisateur ouvre un autre projet : on part donc toujours des données chargées.
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
      // Recopier dans le projet pour que l'enregistrement automatique du
      // Dashboard pousse la prédiction vers Appwrite. Donnée dérivée : écrite hors
      // de l'historique d'annulation.
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
