import { useEffect, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  FREECAM_SPEED_MULTIPLIER_MAX,
  FREECAM_SPEED_MULTIPLIER_MIN,
  FREECAM_SPEED_MULTIPLIER_WHEEL_STEP,
} from '../lib/config';

interface UseFreeCamWheelSpeedArgs {
  map: MapboxMap | null;
  active: boolean;
  speedMultiplierRef: RefObject<number>;
}

/** Molette sur la carte = multiplicateur de vitesse (bloque aussi le zoom page Ctrl+molette). */
export function useFreeCamWheelSpeed({ map, active, speedMultiplierRef }: UseFreeCamWheelSpeedArgs): void {
  useEffect(() => {
    if (!map || !active) return;
    const canvas = map.getCanvas();

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY === 0) return;
      const factor = event.deltaY < 0 ? FREECAM_SPEED_MULTIPLIER_WHEEL_STEP : 1 / FREECAM_SPEED_MULTIPLIER_WHEEL_STEP;
      speedMultiplierRef.current = Math.min(
        FREECAM_SPEED_MULTIPLIER_MAX,
        Math.max(FREECAM_SPEED_MULTIPLIER_MIN, speedMultiplierRef.current * factor),
      );
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => canvas.removeEventListener('wheel', handleWheel, { capture: true });
  }, [map, active, speedMultiplierRef]);
}
