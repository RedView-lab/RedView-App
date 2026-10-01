import {
  concatBrouterRoutes,
  resolveItineraryRouting,
  splitRouteIntoLegs,
  type BrouterRoute,
  type ResolvedRouting,
} from '../../lib/brouter';
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

  // Trop de via pour une requête : tronçons consécutifs routés l'un après
  // l'autre puis recollés, au lieu d'ignorer les via au-delà du plafond.
  const legs = splitRouteIntoLegs(requestBase.start, requestBase.via ?? [], requestBase.end);
  const legRoutes: BrouterRoute[] = [];
  let usedFallbackProfile = false;
  for (const leg of legs) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const legResult = await fetchRouteForPrioritiesWithFallback(
      legs.length === 1 ? requestBase : { ...requestBase, ...leg },
      itinerary.priorities,
      resolved.profileId,
      resolved.stockProfileId,
    );
    legRoutes.push(legResult.route);
    usedFallbackProfile ||= legResult.usedFallbackProfile;
  }
  return {
    route: concatBrouterRoutes(legRoutes),
    usedFallbackProfile,
    resolvedWarnings: resolved.roadTypes.warnings,
    resolved,
  };
}