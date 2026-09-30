import type { ChangeEvent, Dispatch, SetStateAction } from 'react';

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

export interface UseItineraryFitRuntimeResult {
  calculateDisabled: boolean;
  calculateError: string | null;
  calculateLabel: string;
  cancelCalculatePrediction: () => void;
  fitFileNames: string[];
  fitInputRef: React.RefObject<HTMLInputElement | null>;
  handleCalculatePrediction: () => void;
  handleClearFitFiles: () => void;
  handleFitInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleRemoveFitFile: (index: number) => void;
  handleUploadFitRequest: () => void;
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
  };
}