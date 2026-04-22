import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { PredictionResult } from '@/features/fitPredictor';

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
 */
export function PredictionProvider({ children }: PredictionProviderProps) {
  const [predictions, setPredictions] = useState<
    Record<string, PredictionResult | null>
  >({});

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
    },
    [],
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
