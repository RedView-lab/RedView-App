import { isBrouterUnmappedPointError } from '../useItineraryBrouterRoutingShared';
import type { Itinerary } from '../../types';
import type { BrouterRoute } from '../../lib/brouter';

import { fetchRouteForPriorities, type PriorityRouteRequest } from './routingStrategy';

export const STOCK_PROFILE_FALLBACK_WARNING =
  'Profil BRouter personnalisé refusé par le serveur, repli sur le profil de base.';

export type RouteRequestBase = Omit<PriorityRouteRequest, 'profile'>;

function isBrouterHttp422(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes('brouter http 422');
}

function shouldRetryWithStockProfile(
  error: unknown,
  preferredProfile: string,
  fallbackProfile: string,
): boolean {
  return (
    preferredProfile.startsWith('custom_') &&
    fallbackProfile !== preferredProfile &&
    !isBrouterUnmappedPointError(error) &&
    isBrouterHttp422(error)
  );
}

export function applyRouteWarnings(
  resolvedWarnings: string[],
  usedFallbackProfile: boolean,
): string[] {
  return usedFallbackProfile
    ? [...resolvedWarnings, STOCK_PROFILE_FALLBACK_WARNING]
    : resolvedWarnings;
}

export async function fetchRouteForPrioritiesWithFallback(
  reqBase: RouteRequestBase,
  priorities: Itinerary['priorities'],
  preferredProfile: string,
  fallbackProfile: string,
): Promise<{ route: BrouterRoute; usedFallbackProfile: boolean }> {
  try {
    return {
      route: await fetchRouteForPriorities({ ...reqBase, profile: preferredProfile }, priorities),
      usedFallbackProfile: false,
    };
  } catch (error) {
    if (!shouldRetryWithStockProfile(error, preferredProfile, fallbackProfile)) {
      throw error;
    }
    console.warn(
      '[BRouter] custom profile rejected, retrying with stock profile',
      preferredProfile,
      '→',
      fallbackProfile,
      error,
    );
    return {
      route: await fetchRouteForPriorities({ ...reqBase, profile: fallbackProfile }, priorities),
      usedFallbackProfile: true,
    };
  }
}