import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { PredictionResult } from '@/features/fitPredictor';
import { useProjectStoreOptional } from './ProjectStore';

interface PredictionStoreValue {
  /** Map of itineraryId → latest successful prediction result. */
  predictions: Record<string, PredictionResult | null>;
  /** Persist (or clear, when null) the prediction for a given itinerary. */
  setPrediction: (itineraryId: string, result: PredictionResult | null) => void;
  /** Drop every stored prediction (used when the active project changes). */
  clearPredictions: () => void;
}

const PredictionStoreContext = createContext<PredictionStoreValue | null>(null);

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

  // Lazy-initialise from any predictions persisted on the project. This
  // runs once per provider mount; the Dashboard remounts the provider
  // with a fresh `key` whenever the user opens a different project, so
  // we always start from the freshly loaded payload.
  const [predictions, setPredictions] = useState<
    Record<string, PredictionResult | null>
  >(() => {
    const initial: Record<string, PredictionResult | null> = {};
    const itineraries = projectStore?.project.itineraries;
    if (!itineraries) return initial;
    for (const it of itineraries) {
      if (it.prediction) initial[it.id] = it.prediction;
    }
    return initial;
  });

  // Le projet fait foi : dès que la prédiction stockée d'un itinéraire change
  // (undo / redo, édition du tracé qui l'invalide, résultat async), la valeur
  // exposée suit. Sans ça, un undo laissait afficher la prédiction de l'état
  // quitté.
  const lastProjectPredictionsRef = useRef(new Map<string, PredictionResult | null>());
  useEffect(() => {
    const itineraries = projectStore?.project.itineraries;
    if (!itineraries) return;
    const seen = lastProjectPredictionsRef.current;
    const nextSeen = new Map<string, PredictionResult | null>();
    const changed = new Map<string, PredictionResult | null>();
    for (const it of itineraries) {
      const projectValue = it.prediction ?? null;
      nextSeen.set(it.id, projectValue);
      if (!seen.has(it.id) || seen.get(it.id) !== projectValue) {
        changed.set(it.id, projectValue);
      }
    }
    lastProjectPredictionsRef.current = nextSeen;

    setPredictions((prev) => {
      let next = prev;
      const edit = () => {
        if (next === prev) next = { ...prev };
        return next;
      };
      for (const [id, value] of changed) {
        if ((prev[id] ?? null) === value) continue;
        if (value) edit()[id] = value;
        else if (id in prev) delete edit()[id];
      }
      for (const id of Object.keys(prev)) {
        if (!nextSeen.has(id)) delete edit()[id];
      }
      return next;
    });
  }, [projectStore?.project.itineraries]);

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

export function usePredictionStore(): PredictionStoreValue {
  const ctx = useContext(PredictionStoreContext);
  if (!ctx) {
    throw new Error('usePredictionStore must be used within <PredictionProvider>');
  }
  return ctx;
}

export function usePredictionStoreOptional(): PredictionStoreValue | null {
  return useContext(PredictionStoreContext);
}
