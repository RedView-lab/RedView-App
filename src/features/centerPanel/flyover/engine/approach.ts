import { APPROACH_CURVE, APPROACH_MAX_MS, APPROACH_MIN_MS, APPROACH_SPEED } from '../config';
import { EARTH_CIRCUMFERENCE_M } from './geo';

const TILE_SIZE = 512;

/**
 * Zoom Mapbox équivalent à une distance caméra → centre, pour une hauteur de
 * vue et un champ vertical donnés : `cameraToCenterDistance = ½·H / tan(fov/2)`
 * pixels, et un pixel vaut `C·cos φ / (512·2^z)` mètres.
 */
export function zoomForCameraDistance(distanceM: number, latitude: number, viewportHeightPx: number, fovDeg: number): number {
  const cameraToCenterPx = (0.5 * viewportHeightPx) / Math.tan((fovDeg * Math.PI) / 360);
  const metersPerWorld = EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180);
  return Math.log2((cameraToCenterPx * metersPerWorld) / (TILE_SIZE * Math.max(1, distanceM)));
}

/**
 * Durée d'une transition de survol selon van Wijk & Nuij (« Smooth and
 * efficient zooming and panning », le chemin de `flyTo`) : longueur S du
 * chemin optimal divisée par la vitesse, bornée. Centres en Mercator [0, 1].
 */
export function approachDurationMs(
  from: { x: number; y: number; zoom: number },
  to: { x: number; y: number; zoom: number },
  viewport: { width: number; height: number },
): number {
  const rho = APPROACH_CURVE;
  const rho2 = rho * rho;
  const worldSize = TILE_SIZE * 2 ** from.zoom;
  const w0 = Math.max(viewport.width, viewport.height, 1);
  const w1 = w0 / 2 ** (to.zoom - from.zoom);
  const u1 = Math.hypot(to.x - from.x, to.y - from.y) * worldSize;
  let S: number;
  if (u1 < 1e-6) {
    S = Math.abs(Math.log(w1 / w0)) / rho;
  } else {
    const r = (i: 0 | 1) => {
      const w = i ? w1 : w0;
      const b = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) / (2 * w * rho2 * u1);
      return Math.log(Math.sqrt(b * b + 1) - b);
    };
    S = (r(1) - r(0)) / rho;
  }
  if (!Number.isFinite(S)) S = 0;
  return Math.max(APPROACH_MIN_MS, Math.min(APPROACH_MAX_MS, (1000 * S) / APPROACH_SPEED));
}
