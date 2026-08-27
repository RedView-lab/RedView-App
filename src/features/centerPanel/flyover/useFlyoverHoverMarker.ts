import { useCallback, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { HOVER_X_VALUE_EPSILON } from './types';

/**
 * Gère l'état manuel de survol pour le module Flyover.
 */
export function useFlyoverHoverMarker() {
  const manualHoverXValueRef = useRef<number | null>(null);

  const clearHoverMarker = useCallback((_targetMap: MapboxMap | null) => {
    manualHoverXValueRef.current = null;
  }, []);

  const setManualHoverXValue = useCallback((xValue: number | null) => {
    const previousValue = manualHoverXValueRef.current;
    if (previousValue == null || xValue == null) {
      if (previousValue === xValue) return;
    } else if (Math.abs(previousValue - xValue) <= HOVER_X_VALUE_EPSILON) {
      return;
    }
    manualHoverXValueRef.current = xValue;
  }, []);

  return {
    setManualHoverXValue,
    clearHoverMarker,
  };
}
