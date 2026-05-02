import {
  fetchBrouterRoute,
  fetchBrouterRouteBestByScore,
  fetchBrouterRouteBestOfN,
  fetchBrouterRouteBestWithClimbEfficiency,
  fetchBrouterRouteBestWithDistanceDetours,
  type BrouterRoute,
} from '../../lib/brouter';
import type { Itinerary } from '../../types';

export type PriorityRouteRequest = Parameters<typeof fetchBrouterRouteBestByScore>[0];

function prioritySign(value: number): number {
  return Math.max(-1, Math.min(1, ((Math.max(0, Math.min(100, value)) - 50) / 50)));
}

function scoreMaxAscentLongDistance(route: BrouterRoute): number {
  const distanceKm = route.distanceM / 1000;
  const targetClimbDensity = 38;
  const flatGapM = Math.max(0, (distanceKm * targetClimbDensity) - route.ascentM);
  return (route.ascentM * 1150) + (route.distanceM * 0.04) - (flatGapM * 1600);
}

export function fetchRouteForPriorities(
  reqBase: PriorityRouteRequest,
  priorities: Itinerary['priorities'],
): Promise<BrouterRoute> {
  if (reqBase.profile?.startsWith('custom_')) {
    return fetchBrouterRoute(reqBase);
  }

  const climbFocus = Math.max(0, prioritySign(priorities.elevation));
  const distanceAvoid = Math.max(0, -prioritySign(priorities.distance));
  const distanceFocus = Math.max(0, prioritySign(priorities.distance));
  const durationFocus = Math.max(0, prioritySign(priorities.duration));
  if (climbFocus > 0.4 && distanceAvoid > 0.65) {
    return fetchBrouterRouteBestWithClimbEfficiency(reqBase);
  }
  if (distanceAvoid > 0.65) {
    return fetchBrouterRouteBestByScore(
      reqBase,
      (route) => -((route.distanceM * 1.4) + (route.durationS * 18)),
      'min distance + directness',
      4,
    );
  }
  if (climbFocus > 0.4 && distanceFocus > 0.5) {
    return fetchBrouterRouteBestWithDistanceDetours(
      reqBase,
      scoreMaxAscentLongDistance,
      'max ascent + long distance',
      distanceFocus,
      climbFocus,
      4,
    );
  }
  if (climbFocus > 0.4) return fetchBrouterRouteBestOfN(reqBase, 4);
  if (distanceFocus > 0.65) {
    return fetchBrouterRouteBestWithDistanceDetours(
      reqBase,
      (route) => route.distanceM,
      'max distance',
      distanceFocus,
      climbFocus,
      4,
    );
  }
  if (durationFocus > 0.65) {
    return fetchBrouterRouteBestByScore(
      reqBase,
      (route) => -((route.durationS * 35) + route.distanceM),
      'min duration + directness',
      4,
    );
  }
  return fetchBrouterRoute(reqBase);
}