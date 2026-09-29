import type { Map as MapboxMap } from 'mapbox-gl';
import { FREECAM_LOD_MAX_ZOOM, FREECAM_LOD_MIN_DISTANCE_M } from './config';

/**
 * Mapbox choisit le niveau de détail max des tuiles d'après `transform.zoom`
 * (`coveringZoomLevel`). En free camera, ce zoom vient de la distance entre
 * la caméra et le point visé (rayon du regard ∩ terrain) : regarder loin
 * dégrade tout le terrain proche, et un regard qui passe d'une crête à une
 * vallée lointaine fait sauter le LOD.
 *
 * Correctif : plancher du niveau de couverture calculé depuis la hauteur de
 * la caméra au-dessus du sol (distance du terrain le plus proche). Le reste
 * de l'algo Mapbox (LOD décroissant avec la distance) est inchangé : seules
 * les tuiles proches gagnent en détail.
 *
 * API privée Mapbox (`map.transform`) : détectée à l'installation, no-op si
 * absente ; restaurée à la sortie de FreeCam.
 */

interface CoveringOptions {
  tileSize: number;
  roundZoom?: boolean;
}

interface PrivateTransform {
  maxZoom: number;
  tileSize: number;
  cameraToCenterDistance: number;
  center: { lat: number };
  coveringZoomLevel: (this: PrivateTransform, options: CoveringOptions) => number;
}

export interface LodBoostHandle {
  /** Distance (m) du terrain le plus proche, typiquement la hauteur caméra-sol. */
  setNearDistanceM: (distanceM: number) => void;
  uninstall: () => void;
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const DEG_TO_RAD = Math.PI / 180;

const NOOP_HANDLE: LodBoostHandle = {
  setNearDistanceM: () => {},
  uninstall: () => {},
};

function getPatchableTransform(map: MapboxMap): PrivateTransform | null {
  const transform = (map as unknown as { transform?: Partial<PrivateTransform> }).transform;
  if (!transform || typeof transform.coveringZoomLevel !== 'function') return null;
  if (!Number.isFinite(transform.cameraToCenterDistance) || !Number.isFinite(transform.tileSize)) return null;
  return transform as PrivateTransform;
}

/** Zoom Mapbox auquel une tuile située à `distanceM` de la caméra est nette. */
function zoomForDistance(transform: PrivateTransform, distanceM: number): number {
  const circumferenceM = EARTH_CIRCUMFERENCE_M * Math.max(0.01, Math.cos(transform.center.lat * DEG_TO_RAD));
  const distanceMercator = distanceM / circumferenceM;
  return Math.log2(transform.cameraToCenterDistance / (transform.tileSize * distanceMercator));
}

export function installLodBoost(map: MapboxMap): LodBoostHandle {
  const transform = getPatchableTransform(map);
  if (!transform) return NOOP_HANDLE;

  const hadOwnProperty = Object.prototype.hasOwnProperty.call(transform, 'coveringZoomLevel');
  const original = transform.coveringZoomLevel;
  let nearDistanceM = 0;
  let lastFloorZoom = Number.NaN;

  transform.coveringZoomLevel = function boostedCoveringZoomLevel(this: PrivateTransform, options) {
    const base = original.call(this, options);
    if (!(nearDistanceM > 0)) return base;
    const nearZoom = Math.min(this.maxZoom, FREECAM_LOD_MAX_ZOOM, zoomForDistance(this, nearDistanceM));
    const floor = Math.floor(nearZoom + Math.log2(this.tileSize / options.tileSize));
    return Math.max(base, floor);
  };
  map.triggerRepaint();

  return {
    setNearDistanceM(distanceM) {
      nearDistanceM = Math.max(FREECAM_LOD_MIN_DISTANCE_M, distanceM);
      // Repeindre seulement quand le palier entier change : recalcul de la
      // couverture même à l'arrêt (tuiles DEM qui arrivent), sans boucle de rendu.
      const floorZoom = Math.floor(zoomForDistance(transform, nearDistanceM));
      if (floorZoom !== lastFloorZoom) {
        lastFloorZoom = floorZoom;
        map.triggerRepaint();
      }
    },
    uninstall() {
      if (hadOwnProperty) {
        transform.coveringZoomLevel = original;
      } else {
        delete (transform as Partial<PrivateTransform>).coveringZoomLevel;
      }
      map.triggerRepaint();
    },
  };
}
