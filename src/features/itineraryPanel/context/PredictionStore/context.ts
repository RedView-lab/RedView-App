import { createContext } from 'react';

import type { PredictionMap } from './projectPredictions';
import type { PredictionResult } from '@/features/fitPredictor';

export interface PredictionStoreValue {
  /** Table itineraryId → dernier résultat de prédiction réussi. */
  predictions: PredictionMap;
  /** Persiste (ou efface, si null) la prédiction d'un itinéraire donné. */
  setPrediction: (itineraryId: string, result: PredictionResult | null) => void;
  /** Abandonne toutes les prédictions stockées (quand le projet actif change). */
  clearPredictions: () => void;
}

export const PredictionStoreContext = createContext<PredictionStoreValue | null>(null);
