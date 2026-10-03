import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
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

const BATCHED_START_EVENTS = new Set(['movestart', 'zoomstart', 'rotatestart', 'pitchstart']);
const BATCHED_END_EVENTS: Record<string, string> = {
  zoomend: 'zoomstart',
  rotateend: 'rotatestart',
  pitchend: 'pitchstart',
  moveend: 'movestart',
};
const END_EVENT_ORDER = ['zoomend', 'rotateend', 'pitchend', 'moveend'] as const;

export interface CameraEventBatch {
  /** Rend `fire` d'origine et émet les fins de mouvement en attente. */
  release: () => void;
}

/**
 * `setFreeCameraOptions` émet movestart / move / moveend (+ zoom, rotate,
 * pitch start/end) à chaque appel. Image par image, chaque `moveend` vide le
 * cache de drapage des lignes du terrain, force le miroir flou, sauvegarde le
 * viewport… Pendant que le flyover pilote la caméra on retrouve la sémantique
 * d'une animation Mapbox : un seul *start, les `move`/`zoom`/`rotate`/`pitch`
 * à chaque image, un seul *end à la fin. Seuls les événements marqués
 * `FLYOVER_EVENT_DATA` sont regroupés ; le patch est une propriété propre de
 * l'instance, retirée à la libération.
 */
export function batchCameraEvents(map: MapboxMap): CameraEventBatch {
  type Fire = (event: unknown, eventData?: unknown) => MapboxMap;
  const target = map as unknown as { fire: Fire };
  const hadOwnFire = Object.prototype.hasOwnProperty.call(target, 'fire');
  const originalFire = target.fire;
  const started = new Set<string>();
  let released = false;

  target.fire = function batchedFire(this: MapboxMap, event: unknown, eventData?: unknown) {
    const type = typeof event === 'string' ? event : (event as { type?: string } | null)?.type;
    const fromFlyover =
      typeof event === 'string'
        ? (eventData as { flyover?: boolean } | undefined)?.flyover === true
        : (event as { flyover?: boolean } | null)?.flyover === true;
    if (fromFlyover && type) {
      if (BATCHED_START_EVENTS.has(type)) {
        if (started.has(type)) return this;
        started.add(type);
      } else if (type in BATCHED_END_EVENTS) {
        return this;
      }
    }
    return originalFire.call(this, event, eventData);
  };

  return {
    release() {
      if (released) return;
      released = true;
      if (hadOwnFire) target.fire = originalFire;
      else delete (target as Partial<typeof target>).fire;
      for (const end of END_EVENT_ORDER) {
        if (!started.has(BATCHED_END_EVENTS[end])) continue;
        try {
          (map as unknown as { fire: (type: string, data: object) => void }).fire(end, FLYOVER_EVENT_DATA);
        } catch {
          /* carte détruite */
        }
      }
    },
  };
}
