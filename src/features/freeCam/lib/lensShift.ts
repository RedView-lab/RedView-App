import type { Map as MapboxMap, PaddingOptions } from 'mapbox-gl';
import { FREECAM_EVENT_DATA } from './eventData';
import { FREECAM_LENS_SHIFT_MAX_PADDING_RATIO, MAPBOX_FOV_DEG } from './config';

/**
 * Regarder au-dessus de l'horizon. Mapbox refuse un pitch > 85° (et ses
 * calculs de frustum cassent au-delà de 90°). On décale donc le point de
 * fuite vers le bas avec un padding haut, comme un objectif à décentrement :
 * le centre de l'écran vise alors `extraDeg` degrés plus haut que la caméra
 * réelle, et le ciel apparaît. Mapbox gère ce padding nativement (frustum,
 * plan lointain et couverture de tuiles en tiennent compte).
 */

const DEG_TO_RAD = Math.PI / 180;

export interface LensShiftHandle {
  apply: (extraDeg: number) => void;
  restore: () => void;
}

function focalLengthPx(heightPx: number): number {
  return (0.5 * heightPx) / Math.tan((MAPBOX_FOV_DEG * DEG_TO_RAD) / 2);
}

export function installLensShift(map: MapboxMap): LensShiftHandle {
  const current = map.getPadding();
  const base: Required<PaddingOptions> = {
    top: current.top ?? 0,
    bottom: current.bottom ?? 0,
    left: current.left ?? 0,
    right: current.right ?? 0,
  };
  let currentTop = base.top;

  const setTop = (top: number) => {
    if (Math.abs(top - currentTop) < 0.5) return;
    currentTop = top;
    map.setPadding({ ...base, top }, FREECAM_EVENT_DATA);
  };

  return {
    apply(extraDeg) {
      const heightPx = map.getCanvas().clientHeight;
      if (!(heightPx > 0)) return;
      const shiftPx = focalLengthPx(heightPx) * Math.tan(Math.max(0, extraDeg) * DEG_TO_RAD);
      // Le centre du padding descend de padding/2 : padding = 2 × décalage voulu.
      const top = base.top + Math.min(2 * shiftPx, FREECAM_LENS_SHIFT_MAX_PADDING_RATIO * heightPx);
      setTop(top);
    },
    restore() {
      setTop(base.top);
    },
  };
}
