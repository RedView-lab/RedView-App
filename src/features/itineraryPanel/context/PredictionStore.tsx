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
 * autosaver persists them to Supabase. On mount we hydrate from any
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

  // Re-hydrate when itineraries are added / removed (or their saved
  // prediction is replaced by an external mutation).
  const lastSnapshotRef = useRef<string>('');
  useEffect(() => {
    const itineraries = projectStore?.project.itineraries;
    if (!itineraries) return;
    const snapshot = itineraries
      .map((it) => `${it.id}:${it.prediction ? '1' : '0'}`)
      .join('|');
    if (snapshot === lastSnapshotRef.current) return;
    lastSnapshotRef.current = snapshot;

    setPredictions((prev) => {
      const next: Record<string, PredictionResult | null> = {};
      let changed = false;
      const validIds = new Set<string>();
      for (const it of itineraries) {
        validIds.add(it.id);
        if (prev[it.id]) {
          next[it.id] = prev[it.id];
        } else if (it.prediction) {
          next[it.id] = it.prediction;
          changed = true;
        }
      }
      for (const id of Object.keys(prev)) {
        if (!validIds.has(id)) changed = true;
      }
      if (!changed && Object.keys(next).length === Object.keys(prev).length) {
        return prev;
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
      // prediction to Supabase.
      const updateItinerary = projectStore?.updateItinerary;
      if (updateItinerary) {
        updateItinerary(itineraryId, (draft) => {
          if (result === null) {
            if (draft.prediction != null) draft.prediction = null;
          } else if (draft.prediction !== result) {
            draft.prediction = result;
          }
        });
      }
    },
    [projectStore],
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
