import { googleEarthViewFromCamera, type GeoPoint, type GoogleEarthView } from '@/shared/lib/googleEarthView';
import { toWgs84 } from '../lib/coordConvert';
import type { CameraController } from './camera';
import { raycastTerrain } from './route/terrainRaycaster';
import type { ViewerRouteSceneParams } from './route/types';

/**
 * Caméra du viewer LiDAR → vue Google Earth (touche M).
 *
 * L'œil et le point visé passent du repère de rendu (x est, y haut, −z nord
 * de la grille, autour du centre de la scène) au WGS84 par la projection de la
 * tuile ; cap et inclinaison sont recalculés entre ces deux points sur
 * l'ellipsoïde, ce qui corrige d'office la convergence des méridiens (le nord
 * de la grille n'est pas le nord vrai : ±5° en Lambert-93) et son facteur
 * d'échelle. Point visé : la cible de l'orbite, le MNT sous la visée en vue à
 * 360°, sinon un point en l'air sur la visée (vers le ciel).
 */

const DEG = Math.PI / 180;
const SKY_TARGET_DISTANCE_M = 1000;

type ViewerCamera = Pick<CameraController, 'getEye' | 'getForward' | 'getFovY' | 'getMode' | 'getPose'>;

export function googleEarthViewFromViewer(camera: ViewerCamera, scene: ViewerRouteSceneParams): GoogleEarthView | null {
  const eye: [number, number, number] = [...camera.getEye()];
  const forward = camera.getForward();

  let target: [number, number, number];
  if (camera.getMode() === 'orbit') {
    const pose = camera.getPose();
    target = [pose.targetX, pose.targetY, pose.targetZ];
  } else {
    const hit = raycastTerrain({ origin: eye, direction: forward }, scene, eye);
    target = hit
      ? [hit.localX, hit.localY, hit.localZ]
      : [0, 1, 2].map((i) => eye[i] + forward[i] * SKY_TARGET_DISTANCE_M) as [number, number, number];
  }

  const toGeo = ([x, y, z]: [number, number, number]): GeoPoint => {
    const [lon, lat] = toWgs84(x + scene.centerX, -z + scene.centerY, scene.crs);
    return { lon, lat, altitudeM: y + scene.centerZ };
  };
  return googleEarthViewFromCamera(toGeo(eye), toGeo(target), camera.getFovY() / DEG);
}
