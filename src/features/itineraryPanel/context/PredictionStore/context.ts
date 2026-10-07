import { createContext } from 'react';

import type { PredictionMap } from './projectPredictions';
import type { PredictionResult } from '@/features/fitPredictor';

export interface PredictionStoreValue {
  /** Map of itineraryId → latest successful prediction result. */
  predictions: PredictionMap;
  /** Persist (or clear, when null) the prediction for a given itinerary. */
  setPrediction: (itineraryId: string, result: PredictionResult | null) => void;
  /** Drop every stored prediction (used when the active project changes). */
  clearPredictions: () => void;
}

export const PredictionStoreContext = createContext<PredictionStoreValue | null>(null);
