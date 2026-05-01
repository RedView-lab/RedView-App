import { panelProfileToBrouter, resolveItineraryRouting, type BrouterRoute, type ResolvedRouting } from '../../lib/brouter';
import type { Itinerary } from '../../types';

import { fetchRouteForPrioritiesWithFallback, type RouteRequestBase } from './profileFallback';

export interface ResolvedRouteRequest {
  route: BrouterRoute;
  usedFallbackProfile: boolean;
  resolvedWarnings: string[];
  resolved: ResolvedRouting;
}

interface ResolveRouteRequestArgs {
  itinerary: Itinerary;
  signal: AbortSignal;
  requestBase: RouteRequestBase;
  setRouteWarnings: (warnings: string[]) => void;
}

export async function resolveRouteRequest({
  itinerary,
  signal,
  requestBase,
  setRouteWarnings,
}: ResolveRouteRequestArgs): Promise<ResolvedRouteRequest> {
  const resolved = await resolveItineraryRouting(itinerary, signal);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  setRouteWarnings(resolved.roadTypes.warnings);
  const routeResult = await fetchRouteForPrioritiesWithFallback(
    requestBase,
    itinerary.priorities,
    resolved.profileId,
    panelProfileToBrouter(itinerary.profileId),
  );
  return {
    ...routeResult,
    resolvedWarnings: resolved.roadTypes.warnings,
    resolved,
  };
}