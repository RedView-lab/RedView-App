import type { Dispatch, SetStateAction } from 'react';

import type { PredictionResult } from '@/features/fitPredictor';

import type { ItineraryProject } from '../../types';

export type FitRuntimeStatus = 'idle' | 'ready' | 'running' | 'success' | 'error';

export interface ItineraryFitRuntime {
  fitFiles: File[];
  fitFileNames: string[];
  predictionResult: PredictionResult | null;
  progress: string[];
  status: FitRuntimeStatus;
  error: string | null;
  updatedAt: string | null;
  persistedUploadSignature: string;
  /**
   * Avertissement non bloquant sur les .fit : fichiers écartés (illisibles,
   * parcours planifiés) ou ajoutés mais non enregistrés dans le projet (échec
   * d'envoi, ils restent utilisés localement). Distinct de `error` : il ne
   * masque jamais le résultat de la prédiction.
   */
  uploadNotice: string | null;
}

export interface PredictionStoreBridge {
  setPrediction: (itineraryId: string, result: PredictionResult | null) => void;
}

export interface UseItineraryFitRuntimeArgs {
  active: ItineraryProject['itineraries'][number] | null;
  projectId: string | null;
  predictionStore: PredictionStoreBridge | null;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
}

export function createEmptyFitRuntime(): ItineraryFitRuntime {
  return {
    fitFiles: [],
    fitFileNames: [],
    predictionResult: null,
    progress: [],
    status: 'idle',
    error: null,
    updatedAt: null,
    persistedUploadSignature: '',
    uploadNotice: null,
  };
}