import { isBrouterUnmappedPointError } from '../useItineraryBrouterRoutingShared';
import type { Itinerary } from '../../types';
import {
  isBrouterIslandError,
  isBrouterRateLimitError,
  requestBeelineKm,
  type BrouterRoute,
} from '../../lib/brouter';

import { fetchRouteForPriorities, type PriorityRouteRequest } from './routingStrategy';

export const STOCK_PROFILE_FALLBACK_WARNING =
  'Profil BRouter personnalisé refusé par le serveur, repli sur le profil de base.';

export type RouteRequestBase = Omit<PriorityRouteRequest, 'profile'>;

export interface ProfileFallbackOptions {
  /**
   * `false` : un point accroché à un îlot n'entraîne pas de repli sur le profil
   * stock — l'appelant tente d'abord de décaler le point avec le profil
   * personnalisé (resolveRouteRequest).
   */
  retryStockOnIsland?: boolean;
}

function shouldRetryWithStockProfile(
  error: unknown,
  preferredProfile: string,
  fallbackProfile: string,
  userSignal?: AbortSignal,
  options: ProfileFallbackOptions = {},
): boolean {
  // If the user cancelled/switched destination themselves, don't retry
  if (userSignal?.aborted) return false;
  // Quota atteint : un second appel avec le profil de base serait refusé aussi.
  if (isBrouterRateLimitError(error)) return false;
  if (options.retryStockOnIsland === false && isBrouterIslandError(error)) return false;
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
/** Plafond : reste sous le délai de 55 s du proxy /api/brouter. */
const CUSTOM_PROFILE_TIMEOUT_MAX_MS = 45_000;

/**
 * Délai accordé au profil personnalisé avant repli sur le profil stock : un
 * tracé de 1 000 km demande légitimement plus qu'un tracé de 100 km, et le
 * repli change complètement la nature du tracé (profil générique).
 */
export function customProfileTimeoutMs(beelineKm: number): number {
  const extra = Math.max(0, beelineKm - 150) * 40;
  return Math.round(Math.min(CUSTOM_PROFILE_TIMEOUT_MAX_MS, CUSTOM_PROFILE_TIMEOUT_MS + extra));
}

/**
 * Requête de secours : au départ d'un réseau très dense (Paris…), une
 * recherche fine peut explorer longtemps. Passé ce délai, une recherche plus
 * gloutonne — même profil personnalisé — part en parallèle et la première
 * réponse l'emporte : latence bornée, sans repli sur un profil générique.
 */
const HEDGE_SEARCH_WEIGHT = 1.7;

export function hedgeDelayMs(beelineKm: number): number {
  return Math.round(Math.min(8_000, 3_000 + beelineKm * 8));
}

function abortError(): Error {
  return new DOMException('aborted', 'AbortError');
}

/**
 * Première réponse réussie ; l'échec de la fine avant le départ du secours est
 * renvoyé tel quel. Les délais portent sur le calcul : dès que BRouter a
 * répondu (`onComputed`), plus de secours — une connexion lente ne doit pas
 * doubler la charge du serveur pendant le téléchargement.
 */
function fetchWithHedge(
  request: PriorityRouteRequest,
  priorities: Itinerary['priorities'],
  beelineKm: number,
  signal: AbortSignal,
  onComputed: () => void,
): Promise<BrouterRoute> {
  if (request.searchWeight != null) {
    return fetchRouteForPriorities({ ...request, signal, onResponseHeaders: onComputed }, priorities);
  }
  return new Promise<BrouterRoute>((resolve, reject) => {
    const fineCtrl = new AbortController();
    const hedgeCtrl = new AbortController();
    let settled = false;
    let hedgeStarted = false;
    let pending = 1;
    let firstError: unknown = null;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fineCtrl.abort();
      hedgeCtrl.abort();
      run();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? abortError()));
    const onError = (error: unknown) => {
      firstError ??= error;
      pending -= 1;
      if (!hedgeStarted || pending === 0) finish(() => reject(firstError));
    };
    if (signal.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const computed = () => {
      clearTimeout(timer);
      onComputed();
    };
    fetchRouteForPriorities({ ...request, signal: fineCtrl.signal, onResponseHeaders: computed }, priorities)
      .then((route) => finish(() => resolve(route)), onError);
    const timer = setTimeout(() => {
      if (settled) return;
      hedgeStarted = true;
      pending += 1;
      fetchRouteForPriorities(
        { ...request, searchWeight: HEDGE_SEARCH_WEIGHT, signal: hedgeCtrl.signal, onResponseHeaders: onComputed },
        priorities,
      ).then((route) => finish(() => resolve(route)), onError);
    }, hedgeDelayMs(beelineKm));
  });
}

export async function fetchRouteForPrioritiesWithFallback(
  reqBase: RouteRequestBase,
  priorities: Itinerary['priorities'],
  preferredProfile: string,
  fallbackProfile: string,
  options: ProfileFallbackOptions = {},
): Promise<{ route: BrouterRoute; usedFallbackProfile: boolean }> {
  if (!preferredProfile.startsWith('custom_') || preferredProfile === fallbackProfile) {
    return {
      route: await fetchRouteForPriorities({ ...reqBase, profile: preferredProfile }, priorities),
      usedFallbackProfile: false,
    };
  }

  // Délai borné pour le profil personnalisé : les traversées nationales ne
  // doivent jamais rester bloquées.
  const customCtrl = new AbortController();
  const onUserAbort = () => customCtrl.abort();
  reqBase.signal?.addEventListener('abort', onUserAbort, { once: true });
  const beelineKm = requestBeelineKm([reqBase.start, ...(reqBase.via ?? []), reqBase.end]);
  const timer = setTimeout(() => customCtrl.abort(), customProfileTimeoutMs(beelineKm));

  try {
    // Le délai borne le calcul, pas le téléchargement de la réponse.
    const route = await fetchWithHedge(
      { ...reqBase, profile: preferredProfile },
      priorities,
      beelineKm,
      customCtrl.signal,
      () => clearTimeout(timer),
    );
    clearTimeout(timer);
    reqBase.signal?.removeEventListener('abort', onUserAbort);
    return { route, usedFallbackProfile: false };
  } catch (error) {
    clearTimeout(timer);
    reqBase.signal?.removeEventListener('abort', onUserAbort);

    if (!shouldRetryWithStockProfile(error, preferredProfile, fallbackProfile, reqBase.signal, options)) {
      throw error;
    }
    console.warn(
      '[BRouter] custom profile timed out or failed, falling back to stock profile',
      preferredProfile,
      '→',
      fallbackProfile,
      error,
    );
    // Le coefficient de recherche calibré pour le profil personnalisé ne
    // s'applique pas au profil stock.
    return {
      route: await fetchRouteForPriorities(
        { ...reqBase, profile: fallbackProfile, searchCostScale: undefined, onResponseHeaders: undefined },
        priorities,
      ),
      usedFallbackProfile: true,
    };
  }
}
