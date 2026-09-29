import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { FreeCamPose } from '../types';
import { clampPitch } from './motion';
import { FREECAM_EVENT_DATA } from './eventData';
import type { LensShiftHandle } from './lensShift';
import { FREECAM_MAPBOX_MAX_PITCH, FREECAM_MIN_ZOOM, MAPBOX_GLOBE_TO_MERCATOR_ZOOM } from './config';

/** Pose réelle de la caméra (position de l'œil, pas le centre de la carte) : aucun saut à l'activation. */
export function readPoseFromMap(map: MapboxMap): FreeCamPose | null {
  const position = map.getFreeCameraOptions().position;
  if (!position) return null;
  const { lng, lat } = position.toLngLat();
  const altitudeM = position.toAltitude();
  if (![lng, lat, altitudeM].every(Number.isFinite)) return null;
  return {
    lng,
    lat,
    altitudeM,
    pitch: clampPitch(map.getPitch()),
    bearing: map.getBearing(),
  };
}

export function isFreeCameraSupported(map: MapboxMap): boolean {
  return map.getZoom() >= MAPBOX_GLOBE_TO_MERCATOR_ZOOM;
}

/**
 * Remonte le zoom au plancher FreeCam (retour en mercator), puis rend la pose
 * une fois le rendu effectué : la bascule globe → mercator n'a lieu que dans
 * le `_render` Mapbox, l'event `render` part juste après.
 */
export function raiseToFreeCamZoom(map: MapboxMap, onReady: (pose: FreeCamPose | null) => void): void {
  map.jumpTo({ zoom: FREECAM_MIN_ZOOM }, FREECAM_EVENT_DATA);
  map.once('render', () => onReady(readPoseFromMap(map)));
  map.triggerRepaint();
}

/**
 * Applique la pose. Le pitch Mapbox est plafonné à 84.9 ; le surplus (regard
 * vers le ciel) passe en décalage optique, appliqué avant la caméra pour que
 * Mapbox calcule le centre avec le bon point de fuite.
 */
export function applyPoseToMap(map: MapboxMap, pose: FreeCamPose, lensShift: LensShiftHandle): void {
  const mapboxPitch = Math.min(pose.pitch, FREECAM_MAPBOX_MAX_PITCH);
  lensShift.apply(pose.pitch - mapboxPitch);

  const camera = map.getFreeCameraOptions();
  camera.position = mapboxgl.MercatorCoordinate.fromLngLat([pose.lng, pose.lat], pose.altitudeM);
  camera.setPitchBearing(mapboxPitch, pose.bearing);
  map.setFreeCameraOptions(camera, FREECAM_EVENT_DATA);
}
