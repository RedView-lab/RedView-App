import { useEffect, useRef } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { distanceBetweenRoutePlaybackPointsM, type interpolateRoutePointAtDistance } from './playback';
import {
  FLYOVER_BEARING_SMOOTHING,
  FLYOVER_CAMERA_PITCH,
  FLYOVER_CAMERA_ZOOM,
  FLYOVER_CENTER_SMOOTHING,
  FLYOVER_MICRO_TURN_THRESHOLD_DEG,
  FLYOVER_MIN_BEARING_PROGRESS_M,
  FLYOVER_PITCH_SMOOTHING,
  FLYOVER_RELIEF_ENGAGE_THRESHOLD_M,
  FLYOVER_RELIEF_RELEASE_THRESHOLD_M,
  FLYOVER_TURN_LOOKAHEAD_THRESHOLD_DEG,
  FLYOVER_ZOOM_SMOOTHING,
} from './types';
import {
  angularDeltaDegrees,
  clampPitchOffset,
  interpolateBearing,
  interpolateValue,
  smoothReliefPitchOffset,
} from './flyoverMath';

interface UseFlyoverCameraArgs {
  map: MapboxMap | null;
  isPlaying: boolean;
  playbackSessionId: number;
  playbackRoutePoint: ReturnType<typeof interpolateRoutePointAtDistance> | null;
  playbackBearing: number | null;
  playbackCameraTarget: {
    point: { lon: number; lat: number };
    bearing: number | null;
    turnDeltaDeg: number;
    elevationDeltaM?: number | null;
    elevationRangeM?: number | null;
    smoothedGradientPct?: number | null;
  } | null;
}

/**
 * Gère le suivi caméra dynamique, le lissage de cap (bearing) et l'inclinaison selon le relief
 * lors de la lecture cinématique (Flyover).
 */
export function useFlyoverCamera({
  map,
  isPlaying,
  playbackSessionId,
  playbackRoutePoint,
  playbackBearing,
  playbackCameraTarget,
}: UseFlyoverCameraArgs) {
  const lastCameraPointRef = useRef<{ lon: number; lat: number } | null>(null);
  const lastStableBearingRef = useRef<number | null>(null);
  const primedPlaybackSessionRef = useRef<number | null>(null);
  const reliefPitchEnabledRef = useRef(false);
  const reliefPitchOffsetRef = useRef(0);

  useEffect(() => {
    if (!map || !isPlaying || !playbackRoutePoint || !playbackCameraTarget) return;

    const previousCameraPoint = lastCameraPointRef.current;
    const movedDistanceM = distanceBetweenRoutePlaybackPointsM(previousCameraPoint, playbackCameraTarget.point);
    const currentBearing = map.getBearing();
    const previousStableBearing = lastStableBearingRef.current ?? currentBearing;
    const desiredBearing = playbackCameraTarget.bearing ?? playbackBearing ?? previousStableBearing;
    const bearingDelta = angularDeltaDegrees(previousStableBearing, desiredBearing);
    const stableBearing =
      movedDistanceM < FLYOVER_MIN_BEARING_PROGRESS_M && bearingDelta < FLYOVER_MICRO_TURN_THRESHOLD_DEG
        ? previousStableBearing
        : bearingDelta < FLYOVER_MICRO_TURN_THRESHOLD_DEG
          ? previousStableBearing
          : desiredBearing;

    const turnBoostDeg = Math.abs(playbackCameraTarget.turnDeltaDeg);
    const pitchTurnBoost = turnBoostDeg >= FLYOVER_TURN_LOOKAHEAD_THRESHOLD_DEG ? 1.2 : 0;
    const reliefStrengthM = Math.max(
      Math.abs(playbackCameraTarget.elevationDeltaM ?? 0),
      Math.abs(playbackCameraTarget.elevationRangeM ?? 0),
    );
    if (reliefPitchEnabledRef.current) {
      if (reliefStrengthM <= FLYOVER_RELIEF_RELEASE_THRESHOLD_M) {
        reliefPitchEnabledRef.current = false;
      }
    } else if (reliefStrengthM >= FLYOVER_RELIEF_ENGAGE_THRESHOLD_M) {
      reliefPitchEnabledRef.current = true;
    }
    const smoothedGradientPitch = reliefPitchEnabledRef.current
      ? clampPitchOffset(-(playbackCameraTarget.smoothedGradientPct ?? 0) * 0.11)
      : 0;
    const filteredReliefPitch = smoothReliefPitchOffset(
      reliefPitchOffsetRef.current,
      smoothedGradientPitch,
    );
    reliefPitchOffsetRef.current = filteredReliefPitch;
    const targetPitch = FLYOVER_CAMERA_PITCH + pitchTurnBoost + filteredReliefPitch;

    lastCameraPointRef.current = playbackCameraTarget.point;
    lastStableBearingRef.current = stableBearing;

    map.jumpTo({
      center: [
        map.getCenter().lng + (playbackCameraTarget.point.lon - map.getCenter().lng) * FLYOVER_CENTER_SMOOTHING,
        map.getCenter().lat + (playbackCameraTarget.point.lat - map.getCenter().lat) * FLYOVER_CENTER_SMOOTHING,
      ],
      bearing: interpolateBearing(currentBearing, stableBearing, FLYOVER_BEARING_SMOOTHING),
      zoom: interpolateValue(map.getZoom(), FLYOVER_CAMERA_ZOOM, FLYOVER_ZOOM_SMOOTHING),
      pitch: interpolateValue(map.getPitch(), targetPitch, FLYOVER_PITCH_SMOOTHING),
    });
  }, [isPlaying, map, playbackBearing, playbackCameraTarget, playbackRoutePoint]);

  useEffect(() => {
    if (!map || !isPlaying || !playbackRoutePoint || !playbackCameraTarget) return;
    if (primedPlaybackSessionRef.current === playbackSessionId) return;
    primedPlaybackSessionRef.current = playbackSessionId;

    const reliefStrengthM = Math.max(
      Math.abs(playbackCameraTarget.elevationDeltaM ?? 0),
      Math.abs(playbackCameraTarget.elevationRangeM ?? 0),
    );
    const targetPitch =
      FLYOVER_CAMERA_PITCH +
      (reliefStrengthM >= FLYOVER_RELIEF_ENGAGE_THRESHOLD_M
        ? clampPitchOffset(-(playbackCameraTarget.smoothedGradientPct ?? 0) * 0.11)
        : 0);

    map.easeTo({
      center: [playbackCameraTarget.point.lon, playbackCameraTarget.point.lat],
      zoom: Math.max(map.getZoom(), FLYOVER_CAMERA_ZOOM),
      pitch: Math.max(map.getPitch(), targetPitch),
      bearing: lastStableBearingRef.current ?? playbackCameraTarget.bearing ?? playbackBearing ?? map.getBearing(),
      duration: 1600,
      essential: true,
    });
  }, [isPlaying, map, playbackBearing, playbackCameraTarget, playbackRoutePoint, playbackSessionId]);

  return {
    resetCameraState: () => {
      lastCameraPointRef.current = null;
      lastStableBearingRef.current = null;
      primedPlaybackSessionRef.current = null;
      reliefPitchEnabledRef.current = false;
      reliefPitchOffsetRef.current = 0;
    },
  };
}
