import {
  FLYOVER_RELIEF_PITCH_ATTACK_SMOOTHING,
  FLYOVER_RELIEF_PITCH_DEADBAND_DEG,
  FLYOVER_RELIEF_PITCH_MAX_STEP_DEG,
  FLYOVER_RELIEF_PITCH_RELEASE_SMOOTHING,
} from './types';

export function interpolateValue(current: number, target: number, amount: number): number {
  return current + (target - current) * amount;
}

export function interpolateBearing(current: number, target: number, amount: number): number {
  const delta = ((target - current + 540) % 360) - 180;
  return current + delta * amount;
}

export function angularDeltaDegrees(left: number, right: number): number {
  return Math.abs(((right - left + 540) % 360) - 180);
}

export function clampPitchOffset(value: number): number {
  return Math.max(-2.4, Math.min(2.4, value));
}

export function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function smoothReliefPitchOffset(current: number, target: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= FLYOVER_RELIEF_PITCH_DEADBAND_DEG) return current;

  const smoothing = Math.abs(target) > Math.abs(current)
    ? FLYOVER_RELIEF_PITCH_ATTACK_SMOOTHING
    : FLYOVER_RELIEF_PITCH_RELEASE_SMOOTHING;
  const steppedDelta = clampValue(
    delta * smoothing,
    -FLYOVER_RELIEF_PITCH_MAX_STEP_DEG,
    FLYOVER_RELIEF_PITCH_MAX_STEP_DEG,
  );

  return current + steppedDelta;
}
