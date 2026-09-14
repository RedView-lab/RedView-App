import { isBrouterUnmappedPointError } from '../useItineraryBrouterRoutingShared';
import type { Itinerary } from '../../types';
import type { BrouterRoute } from '../../lib/brouter';

import { fetchRouteForPriorities, type PriorityRouteRequest } from './routingStrategy';

export const STOCK_PROFILE_FALLBACK_WARNING =
  'Profil BRouter personnalisé refusé par le serveur, repli sur le profil de base.';

export type RouteRequestBase = Omit<PriorityRouteRequest, 'profile'>;


function shouldRetryWithStockProfile(
  error: unknown,
  preferredProfile: string,
  fallbackProfile: string,
  userSignal?: AbortSignal,
): boolean {
  // If the user cancelled/switched destination themselves, don't retry
  if (userSignal?.aborted) return false;
  return (
    preferredProfile.startsWith('custom_') &&
    fallbackProfile !== preferredProfile &&
    !isBrouterUnmappedPointError(error)
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

const CUSTOM_PROFILE_TIMEOUT_MS = 14_000;

export async function fetchRouteForPrioritiesWithFallback(
  reqBase: RouteRequestBase,
  priorities: Itinerary['priorities'],
  preferredProfile: string,
  fallbackProfile: string,
): Promise<{ route: BrouterRoute; usedFallbackProfile: boolean }> {
  if (!preferredProfile.startsWith('custom_') || preferredProfile === fallbackProfile) {
    return {
      route: await fetchRouteForPriorities({ ...reqBase, profile: preferredProfile }, priorities),
      usedFallbackProfile: false,
    };
  }

  // Wrap custom profile attempt in a 14s timeout so national traverses never stall
  const customCtrl = new AbortController();
  const onUserAbort = () => customCtrl.abort();
  reqBase.signal?.addEventListener('abort', onUserAbort, { once: true });
  const timer = setTimeout(() => customCtrl.abort(), CUSTOM_PROFILE_TIMEOUT_MS);

  try {
    const route = await fetchRouteForPriorities(
      { ...reqBase, profile: preferredProfile, signal: customCtrl.signal },
      priorities,
    );
    clearTimeout(timer);
    reqBase.signal?.removeEventListener('abort', onUserAbort);
    return { route, usedFallbackProfile: false };
  } catch (error) {
    clearTimeout(timer);
    reqBase.signal?.removeEventListener('abort', onUserAbort);

    if (!shouldRetryWithStockProfile(error, preferredProfile, fallbackProfile, reqBase.signal)) {
      throw error;
    }
    console.warn(
      '[BRouter] custom profile timed out or failed, falling back to stock profile',
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