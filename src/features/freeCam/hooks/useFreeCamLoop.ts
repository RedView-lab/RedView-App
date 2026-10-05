import { useEffect, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { FreeCamPose } from '../types';
import {
  FREECAM_ACCELERATE_TIME_S,
  FREECAM_BRAKE_TIME_S,
  FREECAM_GROUND_LOOKAHEAD_S,
  FREECAM_HORIZONTAL_SPEED_MAX_MPS,
  FREECAM_HORIZONTAL_SPEED_MIN_MPS,
  FREECAM_HORIZONTAL_SPEED_PER_AGL,
  FREECAM_MAX_FRAME_DT_S,
  FREECAM_MIN_ZOOM,
  FREECAM_MOUSE_SENSITIVITY_DEG_PER_PX,
  FREECAM_REST_SPEED_RATIO,
  FREECAM_VERTICAL_SPEED_MAX_MPS,
  FREECAM_VERTICAL_SPEED_MIN_MPS,
  FREECAM_VERTICAL_SPEED_PER_AGL,
} from '../lib/config';
import { consumeLookDelta, readAxes, type FreeCamInputState } from '../lib/inputState';
import { applyLook, offsetLngLat, speedForHeight } from '../lib/motion';
import {
  advancePoseByVelocity,
  approachVelocity,
  settleVelocity,
  targetVelocity,
  ZERO_VELOCITY,
  type FreeCamVelocity,
} from '../lib/velocity';
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
 * Boucle de vol : input → vélocité → pose → garde-sol → application à Mapbox.
 * Vélocité (`lib/velocity.ts`) : la caméra accélère vers la vitesse demandée
 * et glisse au relâchement, puis s'arrête net sous un seuil ; au repos la
 * carte n'est plus touchée (zéro dérive, zéro event inutile). Une pose
 * remplacée hors de la boucle (autre mouvement de carte, remontée de zoom)
 * annule l'élan.
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
    let velocity: FreeCamVelocity = ZERO_VELOCITY;
    /** Dernière pose écrite par la boucle : une autre dans `poseRef` = élan perdu. */
    let writtenPose: FreeCamPose | null = null;
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
      if (pose !== writtenPose) velocity = ZERO_VELOCITY;

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
      const moving = velocity !== ZERO_VELOCITY;
      if (look.dx === 0 && look.dy === 0 && axes.forward === 0 && axes.strafe === 0 && axes.vertical === 0 && !moving) {
        writtenPose = pose;
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

      const target = targetVelocity(looked.bearing, axes, horizontalSpeed, verticalSpeed);
      velocity = settleVelocity(
        approachVelocity(velocity, target, dt, {
          accelerateTimeS: FREECAM_ACCELERATE_TIME_S,
          brakeTimeS: FREECAM_BRAKE_TIME_S,
        }),
        target,
        horizontalSpeed * FREECAM_REST_SPEED_RATIO,
      );

      const next = advancePoseByVelocity(looked, velocity, dt);

      const lookahead = offsetLngLat(
        next.lng,
        next.lat,
        velocity.eastMps * FREECAM_GROUND_LOOKAHEAD_S,
        velocity.northMps * FREECAM_GROUND_LOOKAHEAD_S,
      );
      const groundM = sampleGroundM(map, [next.lng, next.lat], lookahead) ?? lastGroundM;
      lastGroundM = groundM;
      const clearedAltitudeM = clampAboveGround(next.altitudeM, groundM);
      // Posée sur le sol : l'élan vers le bas est absorbé (pas de rebond au redécollage).
      if (clearedAltitudeM > next.altitudeM && velocity.upMps < 0) velocity = { ...velocity, upMps: 0 };
      next.altitudeM = clearedAltitudeM;

      // Plafond : sous le zoom 6 la carte repasse en globe, où la free camera est ignorée.
      if (next.altitudeM > looked.altitudeM && map.getZoom() <= FREECAM_MIN_ZOOM) {
        next.altitudeM = looked.altitudeM;
        if (velocity.upMps > 0) velocity = { ...velocity, upMps: 0 };
      }

      try {
        applyPoseToMap(map, next, lensShift);
      } catch {
        return; // carte en cours de destruction / changement de style
      }

      // Relit la position réellement retenue (Mapbox peut la contraindre),
      // en gardant l'orientation voulue (pitch > 85 inclus) sans dérive d'arrondi.
      const applied = readPoseFromMap(map);
      writtenPose = applied ? { ...applied, pitch: next.pitch, bearing: next.bearing } : next;
      poseRef.current = writtenPose;
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
