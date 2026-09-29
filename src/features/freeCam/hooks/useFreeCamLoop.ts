import { useEffect, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { FreeCamPose } from '../types';
import {
  FREECAM_GROUND_LOOKAHEAD_S,
  FREECAM_HORIZONTAL_SPEED_MAX_MPS,
  FREECAM_HORIZONTAL_SPEED_MIN_MPS,
  FREECAM_HORIZONTAL_SPEED_PER_AGL,
  FREECAM_MAX_FRAME_DT_S,
  FREECAM_MIN_ZOOM,
  FREECAM_MOUSE_SENSITIVITY_DEG_PER_PX,
  FREECAM_VERTICAL_SPEED_MAX_MPS,
  FREECAM_VERTICAL_SPEED_MIN_MPS,
  FREECAM_VERTICAL_SPEED_PER_AGL,
} from '../lib/config';
import { consumeLookDelta, readAxes, type FreeCamInputState } from '../lib/inputState';
import { advancePose, applyLook, horizontalDisplacementM, offsetLngLat, speedForHeight } from '../lib/motion';
import { clampAboveGround, queryRenderedGroundM, sampleGroundM } from '../lib/terrainClearance';
import { applyPoseToMap, isFreeCameraSupported, raiseToFreeCamZoom, readPoseFromMap } from '../lib/cameraBridge';
import { installLensShift } from '../lib/lensShift';
import { installLodBoost } from '../lib/lodBoost';

interface UseFreeCamLoopArgs {
  map: MapboxMap | null;
  active: boolean;
  input: FreeCamInputState;
  poseRef: RefObject<FreeCamPose | null>;
  speedMultiplierRef: RefObject<number>;
}

/**
 * Boucle de vol : input → pose → garde-sol → application à Mapbox.
 * Arrêt sec : la pose ne bouge que tant qu'une touche est tenue, et la carte
 * n'est touchée que sur les frames avec input (zéro dérive, zéro event inutile).
 * Le LOD proche et le décalage optique (regard vers le ciel) vivent le temps du vol.
 */
export function useFreeCamLoop({ map, active, input, poseRef, speedMultiplierRef }: UseFreeCamLoopArgs): void {
  useEffect(() => {
    if (!map || !active) return;

    const lensShift = installLensShift(map);
    const lodBoost = installLodBoost(map);
    let frameId = 0;
    let lastTime = performance.now();
    let lastGroundM: number | null = null;
    let recovering = false;
    let cancelled = false;

    const heightAboveGround = (pose: FreeCamPose): number => {
      const groundM = queryRenderedGroundM(map, pose.lng, pose.lat) ?? lastGroundM ?? 0;
      return pose.altitudeM - groundM;
    };

    const step = (time: number) => {
      frameId = requestAnimationFrame(step);
      const dt = Math.min(Math.max(0, (time - lastTime) / 1000), FREECAM_MAX_FRAME_DT_S);
      lastTime = time;

      const pose = poseRef.current;
      if (!pose || recovering) return;

      // Garde-fou : regarder vers l'horizon en altitude éloigne le centre et
      // fait chuter le zoom ; sous 6 la carte repasse en globe et ignorerait
      // la free camera (caméra figée). On remonte le zoom et on resynchronise.
      if (!isFreeCameraSupported(map)) {
        recovering = true;
        poseRef.current = null;
        raiseToFreeCamZoom(map, (recovered) => {
          recovering = false;
          if (!cancelled) poseRef.current = recovered;
        });
        return;
      }

      // Même à l'arrêt : les tuiles DEM qui arrivent changent la hauteur-sol.
      lodBoost.setNearDistanceM(heightAboveGround(pose));

      const look = consumeLookDelta(input);
      const axes = readAxes(input);
      if (look.dx === 0 && look.dy === 0 && axes.forward === 0 && axes.strafe === 0 && axes.vertical === 0) {
        return;
      }

      const looked = applyLook(pose, look, FREECAM_MOUSE_SENSITIVITY_DEG_PER_PX);

      const heightAboveGroundM = heightAboveGround(looked);
      const multiplier = speedMultiplierRef.current;
      const horizontalSpeed = multiplier * speedForHeight(
        heightAboveGroundM,
        FREECAM_HORIZONTAL_SPEED_PER_AGL,
        FREECAM_HORIZONTAL_SPEED_MIN_MPS,
        FREECAM_HORIZONTAL_SPEED_MAX_MPS,
      );
      const verticalSpeed = multiplier * speedForHeight(
        heightAboveGroundM,
        FREECAM_VERTICAL_SPEED_PER_AGL,
        FREECAM_VERTICAL_SPEED_MIN_MPS,
        FREECAM_VERTICAL_SPEED_MAX_MPS,
      );

      const next = advancePose(looked, axes, horizontalSpeed, verticalSpeed, dt);

      const ahead = horizontalDisplacementM(next.bearing, axes, horizontalSpeed, FREECAM_GROUND_LOOKAHEAD_S);
      const lookahead = offsetLngLat(next.lng, next.lat, ahead.eastM, ahead.northM);
      const groundM = sampleGroundM(map, [next.lng, next.lat], lookahead) ?? lastGroundM;
      lastGroundM = groundM;
      next.altitudeM = clampAboveGround(next.altitudeM, groundM);

      // Plafond : sous le zoom 6 la carte repasse en globe, où la free camera est ignorée.
      if (next.altitudeM > looked.altitudeM && map.getZoom() <= FREECAM_MIN_ZOOM) {
        next.altitudeM = looked.altitudeM;
      }

      try {
        applyPoseToMap(map, next, lensShift);
      } catch {
        return; // carte en cours de destruction / changement de style
      }

      // Relit la position réellement retenue (Mapbox peut la contraindre),
      // en gardant l'orientation voulue (pitch > 85 inclus) sans dérive d'arrondi.
      const applied = readPoseFromMap(map);
      poseRef.current = applied ? { ...applied, pitch: next.pitch, bearing: next.bearing } : next;
    };

    frameId = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      try {
        lensShift.restore();
      } catch {
        /* carte détruite */
      }
      lodBoost.uninstall();
    };
  }, [map, active, input, poseRef, speedMultiplierRef]);
}
