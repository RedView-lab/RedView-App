import { FLYOVER_SPEED_STEPS } from './config';
import type { CameraRail } from './engine/cameraRail';
import { playbackDurationForLength } from './engine/laws';
import type { FlyoverPhase, FlyoverRouteInput, FlyoverStatus } from './types';

/** Même trace (même itinéraire, mêmes tableaux de points et de distances). */
export function sameRoute(a: FlyoverRouteInput | null, b: FlyoverRouteInput | null): boolean {
  return a === b || (a != null && b != null && a.itineraryId === b.itineraryId && a.points === b.points && a.distancesM === b.distancesM);
}

/** Statut de lecture diffusé à React, à partir de l'état du contrôleur. */
export function buildFlyoverStatus(state: {
  route: FlyoverRouteInput | null;
  /** Rail de la session ouverte, s'il y en a une. */
  session: { rail: CameraRail; distanceM: number; transport: { playbackTime: number } } | null;
  /** Dernier rail calculé (null : rail impossible pour cette trace). */
  railCache: { route: FlyoverRouteInput; rail: CameraRail | null } | null;
  speedIndex: number;
  phase: FlyoverPhase;
  isPlaying: boolean;
}): FlyoverStatus {
  const { route, session, railCache } = state;
  const multiplier = FLYOVER_SPEED_STEPS[state.speedIndex];
  const cachedRail = railCache && route && sameRoute(railCache.route, route) ? railCache.rail : null;
  const rail = session?.rail ?? cachedRail;
  const totalM = rail?.lengthM ?? (route ? route.distancesM[route.distancesM.length - 1] ?? 0 : 0);
  // Un rail déjà tenté et impossible (trace dégénérée) interdit la lecture.
  const railFailed = railCache != null && route != null && sameRoute(railCache.route, route) && railCache.rail == null;
  const canPlay = Boolean(route && route.points.length >= 2 && totalM > 1 && !railFailed);
  const durationAt1x = rail?.durationS ?? playbackDurationForLength(totalM);
  return {
    canPlay,
    phase: state.phase,
    isPlaying: state.isPlaying,
    playbackActive: session != null,
    speedIndex: state.speedIndex,
    distanceM: session ? session.distanceM : null,
    totalM,
    elapsedS: session ? session.transport.playbackTime / multiplier : 0,
    durationS: durationAt1x / multiplier,
  };
}
