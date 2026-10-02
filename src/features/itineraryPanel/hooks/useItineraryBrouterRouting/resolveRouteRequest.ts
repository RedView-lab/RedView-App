import {
  COARSE_SEARCH_WEIGHT,
  buildAnchoredVia,
  buildIslandRepairCandidates,
  concatBrouterRoutes,
  isBrouterIslandError,
  isBrouterRateLimitError,
  needsLongDistanceAnchors,
  resolveItineraryRouting,
  splitRouteIntoLegs,
  type BrouterLeg,
  type BrouterRoute,
  type ResolvedRouting,
} from '../../lib/brouter';
import type { Itinerary } from '../../types';
import { translateAppText } from '@/shared/i18n';

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

interface RoutedLegs {
  route: BrouterRoute;
  usedFallbackProfile: boolean;
  warnings: string[];
}

/**
 * Un îlot échoue vite (petit sous-graphe) : au-delà, l'échec vient d'ailleurs
 * et des essais supplémentaires ne feraient que rallonger l'attente.
 */
const ISLAND_REPAIR_MAX_FAILURE_MS = 8_000;

function islandWarning(isFirstPoint: boolean, isLastPoint: boolean, distance: number): string {
  if (isFirstPoint) {
    return translateAppText('Point de départ isolé du réseau routable : décalé de {{distance}} m pour calculer le tracé.', { distance });
  }
  if (isLastPoint) {
    return translateAppText('Point d’arrivée isolé du réseau routable : décalé de {{distance}} m pour calculer le tracé.', { distance });
  }
  return translateAppText('Point de passage isolé du réseau routable : décalé de {{distance}} m pour calculer le tracé.', { distance });
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function routeCost(route: BrouterRoute): number {
  return Number((route.raw.features?.[0]?.properties as { cost?: unknown } | undefined)?.cost);
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

  const base: RouteRequestBase = { ...requestBase, searchCostScale: resolved.searchCostScale };
  const routeLegs = (request: RouteRequestBase, ends?: LegEnds) => routeAllLegs(request, itinerary, resolved, signal, ends);
  const finish = (result: RoutedLegs): ResolvedRouteRequest => ({
    route: result.route,
    usedFallbackProfile: result.usedFallbackProfile,
    resolvedWarnings: [...resolved.roadTypes.warnings, ...new Set(result.warnings)],
    resolved,
  });

  const userPoints = [base.start, ...(base.via ?? []), base.end];
  if (!resolved.profileId.startsWith('custom_') || !needsLongDistanceAnchors(userPoints)) {
    return finish(await routeLegs(base));
  }

  // Très long tracé : tracé grossier rapide → ancres → tronçons courts affinés.
  let coarse: RoutedLegs;
  try {
    coarse = await routeLegs({ ...base, searchWeight: COARSE_SEARCH_WEIGHT });
  } catch (error) {
    if (signal.aborted || isAbortError(error) || isBrouterRateLimitError(error)) throw error;
    return finish(await routeLegs(base));
  }
  // Même le tracé grossier a dû se replier sur le profil stock : inutile d'insister.
  if (coarse.usedFallbackProfile) return finish(coarse);
  const anchoredVia = buildAnchoredVia(userPoints, coarse.route.coordinates);
  if (!anchoredVia) return finish(coarse);

  try {
    const refined = await routeAnchoredHalves({ ...base, via: anchoredVia }, routeLegs);
    // Le tracé grossier passe par les ancres : l'affinage ne doit jamais faire
    // pire, ni se replier sur le profil stock alors que le grossier a abouti.
    const refinedCost = routeCost(refined.route);
    const coarseCost = routeCost(coarse.route);
    if (refined.usedFallbackProfile || (Number.isFinite(refinedCost) && Number.isFinite(coarseCost) && refinedCost > coarseCost)) {
      return finish(coarse);
    }
    return finish({ ...refined, warnings: [...coarse.warnings, ...refined.warnings] });
  } catch (error) {
    if (signal.aborted || isAbortError(error) || isBrouterRateLimitError(error)) throw error;
    return finish(coarse);
  }
}

/**
 * Tronçons ancrés en deux moitiés calculées en parallèle (2 threads BRouter) :
 * BRouter enchaîne les tronçons d'une requête l'un après l'autre, et un
 * tracé de 1 000 km en compte 6 à 8.
 */
async function routeAnchoredHalves(
  request: RouteRequestBase,
  routeLegs: (request: RouteRequestBase, ends?: LegEnds) => Promise<RoutedLegs>,
): Promise<RoutedLegs> {
  const via = request.via ?? [];
  if (via.length < 3) return routeLegs(request);
  const mid = Math.floor(via.length / 2);
  const [first, second] = await Promise.all([
    routeLegs({ ...request, via: via.slice(0, mid), end: via[mid]! }, { start: true, end: false }),
    routeLegs({ ...request, start: via[mid]!, via: via.slice(mid + 1) }, { start: false, end: true }),
  ]);
  return {
    route: concatBrouterRoutes([first.route, second.route]),
    usedFallbackProfile: first.usedFallbackProfile || second.usedFallbackProfile,
    warnings: [...first.warnings, ...second.warnings],
  };
}

/** Le premier / dernier point de la requête est-il le départ / l'arrivée de l'utilisateur ? */
interface LegEnds {
  start: boolean;
  end: boolean;
}

/** Route départ → via… → arrivée (tronçons de 14 via au plus), points îlots réparés. */
async function routeAllLegs(
  request: RouteRequestBase,
  itinerary: Itinerary,
  resolved: ResolvedRouting,
  signal: AbortSignal,
  ends: LegEnds = { start: true, end: true },
): Promise<RoutedLegs> {
  // Trop de via pour une requête : tronçons consécutifs routés l'un après
  // l'autre puis recollés, au lieu d'ignorer les via au-delà du plafond.
  const legs = splitRouteIntoLegs(request.start, request.via ?? [], request.end);
  const legRoutes: BrouterRoute[] = [];
  const warnings: string[] = [];
  let usedFallbackProfile = false;

  const fetchLeg = (leg: BrouterLeg, retryStockOnIsland: boolean) =>
    fetchRouteForPrioritiesWithFallback(
      { ...request, ...leg },
      itinerary.priorities,
      resolved.profileId,
      resolved.stockProfileId,
      { retryStockOnIsland },
    );

  for (const [legIndex, leg] of legs.entries()) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const t0 = Date.now();
    let legResult: Awaited<ReturnType<typeof fetchLeg>>;
    try {
      legResult = await fetchLeg(leg, false);
    } catch (error) {
      if (!isBrouterIslandError(error) || signal.aborted) throw error;
      // Point accroché à un îlot du graphe : on le décale vers son voisin,
      // avec le profil personnalisé, avant tout repli sur le profil stock.
      const repaired = Date.now() - t0 <= ISLAND_REPAIR_MAX_FAILURE_MS
        ? await repairIslandLeg(leg, error, (candidate) => fetchLeg(candidate, false), signal)
        : null;
      if (repaired) {
        const points = [leg.start, ...leg.via, leg.end];
        warnings.push(islandWarning(
          ends.start && legIndex === 0 && repaired.movedIndex === 0,
          ends.end && legIndex === legs.length - 1 && repaired.movedIndex === points.length - 1,
          repaired.movedM,
        ));
        legResult = repaired.result;
      } else {
        legResult = await fetchLeg(leg, true);
      }
    }
    legRoutes.push(legResult.route);
    usedFallbackProfile ||= legResult.usedFallbackProfile;
  }
  return { route: concatBrouterRoutes(legRoutes), usedFallbackProfile, warnings };
}

async function repairIslandLeg<T>(
  leg: BrouterLeg,
  error: unknown,
  fetchLeg: (leg: BrouterLeg) => Promise<T>,
  signal: AbortSignal,
): Promise<{ result: T; movedIndex: number; movedM: number } | null> {
  for (const candidate of buildIslandRepairCandidates([leg.start, ...leg.via, leg.end], error)) {
    if (signal.aborted) return null;
    try {
      const result = await fetchLeg({
        start: candidate.points[0]!,
        via: candidate.points.slice(1, -1),
        end: candidate.points[candidate.points.length - 1]!,
      });
      return { result, movedIndex: candidate.movedIndex, movedM: candidate.movedM };
    } catch (retryError) {
      if (isBrouterRateLimitError(retryError) || !isBrouterIslandError(retryError)) throw retryError;
    }
  }
  return null;
}
