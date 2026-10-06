import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import { batchDrivenCameraEvents, type CameraEventBatch } from '@/features/map3d/lib/cameraEventBatch';
import type { CameraPose } from '../engine/cameraPose';
import { metersPerMercatorUnitAtY } from '../engine/geo';

/** Marqueur ajouté aux événements caméra émis par le flyover. */
export const FLYOVER_EVENT_DATA = { flyover: true } as const;

/** Pitch max accepté par `setFreeCameraOptions` (maxPitch Mapbox 85, non relevable). */
const MAX_FREE_CAMERA_PITCH_DEG = 84.9;

function isFreeCameraAvailable(map: MapboxMap): boolean {
  // Sous le zoom 6 la carte est en globe, projection qui ignore la FreeCamera.
  return map.getZoom() >= 6;
}

/** Place la caméra (œil + orientation). Rend `false` si Mapbox la refuse (globe, style en cours de remplacement). */
export function applyCameraPose(map: MapboxMap, pose: CameraPose): boolean {
  try {
    const camera = map.getFreeCameraOptions();
    const altitudeUnits = pose.altitudeM / metersPerMercatorUnitAtY(pose.y);
    camera.position = new mapboxgl.MercatorCoordinate(pose.x, pose.y, altitudeUnits);
    camera.setPitchBearing(Math.min(MAX_FREE_CAMERA_PITCH_DEG, Math.max(0, pose.pitchDeg)), pose.bearingDeg);
    map.setFreeCameraOptions(camera, FLYOVER_EVENT_DATA);
    return true;
  } catch {
    return false;
  }
}

/** Pose réelle de la caméra (position de l'œil), `null` en projection globe. */
export function readCameraPose(map: MapboxMap, out: CameraPose): CameraPose | null {
  if (!isFreeCameraAvailable(map)) return null;
  try {
    const position = map.getFreeCameraOptions().position;
    if (!position) return null;
    out.x = position.x;
    out.y = position.y;
    out.altitudeM = position.toAltitude();
    out.pitchDeg = map.getPitch();
    out.bearingDeg = map.getBearing();
    return [out.x, out.y, out.altitudeM, out.pitchDeg, out.bearingDeg].every(Number.isFinite) ? out : null;
  } catch {
    return null;
  }
}

export type { CameraEventBatch } from '@/features/map3d/lib/cameraEventBatch';

/**
 * Événements caméra du flyover regroupés comme une animation Mapbox (un seul
 * *start, les `move` à chaque image, un seul *end à la libération) : voir
 * `batchDrivenCameraEvents` (map3d/lib/cameraEventBatch.ts). Seuls les
 * événements marqués `FLYOVER_EVENT_DATA` sont regroupés.
 */
export function batchCameraEvents(map: MapboxMap): CameraEventBatch {
  return batchDrivenCameraEvents(map, 'flyover');
}
