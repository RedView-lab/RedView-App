/**
 * Climb-seeker (max-hilly) mode detection.
 *
 * Mirrors the logic in `brf-template.ts`: the Dénivelé slider activates
 * "climbing mode" once it exceeds 70 (sElev > 0.4). In that regime the
 * generated BRF inflates flat-road costfactors and lowers cutoffs, AND
 * the routing layer fans out a best-of-N alternative search so we can
 * pick whichever variant climbs the most.
 *
 * Single source of truth so the panel container, the test harness and
 * the BRF generator can't drift.
 */
import type { PrioritiesState } from '../../../types';

/** Slider threshold above which we switch to multi-alternative routing. */
export const CLIMBING_SLIDER_THRESHOLD = 70;

/**
 * `true` when the elevation slider is high enough that we should:
 *  1. emit the climbing-mode BRF (low cutoffs + climb_mul road inflation),
 *  2. fan out best-of-N alternative routes and keep the steepest one.
 */
export function isClimbingMode(priorities: PrioritiesState): boolean {
  return priorities.elevation > CLIMBING_SLIDER_THRESHOLD;
}
