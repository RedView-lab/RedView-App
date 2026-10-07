import { useContext } from 'react';

import { PredictionStoreContext, type PredictionStoreValue } from './context';

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
