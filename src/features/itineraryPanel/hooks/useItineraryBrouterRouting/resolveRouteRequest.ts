import {
  COARSE_SEARCH_WEIGHT,
  GREEDY_COARSE_SEARCH_WEIGHT,
  TIGHT_ANCHOR_SPACING_KM,
  buildAnchoredVia,
  buildIslandRepairCandidates,
  concatBrouterRoutes,
  isBrouterIslandError,
  isBrouterRateLimitError,
  needsLongDistanceAnchors,
  resolveItineraryRouting,
  splitRouteIntoLegs,
  type BrouterLeg,
  type BrouterPoint,
  type BrouterRoute,
  type ResolvedRouting,
} from '../../lib/brouter';
import type { Itinerary } from '../../types';
import { translateAppText } from '@/shared/i18n';

import { fetchCustomProfileRoute, type RouteRequestBase } from './customProfileFetch';

export interface ResolvedRouteRequest {
  route: BrouterRoute;
  resolvedWarnings: string[];
  resolved: ResolvedRouting;
}

interface ResolveRouteRequestArgs {
  itinerary: Itinerary;
  signal: AbortSignal;
  requestBase: RouteRequestBase;
  setRouteWarnings: (warnings: string[]) => void;
  /**
   * Tracé déjà connu du départ à l'arrivée de la requête ([lon, lat], GPX
   * importé) : les ancres y sont prises directement, sans tracé grossier.
   */
  referenceTrack?: [number, number][];
}

interface RoutedLegs {
  route: BrouterRoute;
  warnings: string[];
}

type RouteLegs = (request: RouteRequestBase, ends?: LegEnds) => Promise<RoutedLegs>;

interface AnchorOptions {
  spacingKm?: number;
  minSectionKm?: number;
}

/** Ancres resserrées : tronçon court dont la recherche fine n'a pas abouti. */
const TIGHT_ANCHORS: AnchorOptions = { spacingKm: TIGHT_ANCHOR_SPACING_KM, minSectionKm: 0 };

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

function routeCost(route: BrouterRoute): number {
  return Number((route.raw.features?.[0]?.properties as { cost?: unknown } | undefined)?.cost);
}

/**
 * Échec qu'une autre méthode de recherche peut surmonter (délai dépassé,
 * watchdog, serveur saturé) — par opposition à l'annulation, au quota et aux
 * points eux-mêmes (hors carte, zone interdite, îlot, aucun chemin permis par
 * le profil), qu'aucune recherche ne changera.
 */
function canEscalate(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || isBrouterRateLimitError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/not mapped|restricted area|island detected|no track found/i.test(message);
}

/**
 * Tracé départ → via… → arrivée, toujours avec le profil personnalisé de
 * l'itinéraire. Jamais de repli sur un profil stock : un tronçon trop long
 * pour une recherche fine passe par un tracé grossier et des ancres, et une
 * recherche fine qui n'aboutit pas reprend la même méthode, ancres resserrées.
 */
export async function resolveRouteRequest({
  itinerary,
  signal,
  requestBase,
  setRouteWarnings,
  referenceTrack,
}: ResolveRouteRequestArgs): Promise<ResolvedRouteRequest> {
  const resolved = await resolveItineraryRouting(itinerary, signal);
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  setRouteWarnings(resolved.roadTypes.warnings);

  const base: RouteRequestBase = { ...requestBase, searchCostScale: resolved.searchCostScale };
  const routeLegs: RouteLegs = (request, ends) => routeAllLegs(request, resolved, signal, ends);
  const finish = (result: RoutedLegs): ResolvedRouteRequest => ({
    route: result.route,
    resolvedWarnings: [...resolved.roadTypes.warnings, ...new Set(result.warnings)],
    resolved,
  });

  const userPoints = [base.start, ...(base.via ?? []), base.end];
  if (needsLongDistanceAnchors(userPoints)) {
    // Très long tracé : tracé grossier rapide → ancres → tronçons courts affinés.
    return finish(await routeWithAnchors(base, userPoints, routeLegs, signal, {}, referenceTrack));
  }
  try {
    return finish(await routeLegs(base));
  } catch (error) {
    if (!canEscalate(error, signal)) throw error;
    console.warn('[BRouter] fine search failed, retrying through tight anchors', error);
    return finish(await routeWithAnchors(base, userPoints, routeLegs, signal, TIGHT_ANCHORS, referenceTrack));
  }
}

/**
 * Ancres posées sur `referenceTrack` s'il est fourni, sinon sur un tracé
 * grossier calculé d'abord, puis tronçons affinés entre les ancres.
 */
async function routeWithAnchors(
  base: RouteRequestBase,
  userPoints: BrouterPoint[],
  routeLegs: RouteLegs,
  signal: AbortSignal,
  anchorOptions: AnchorOptions,
  referenceTrack?: [number, number][],
): Promise<RoutedLegs> {
  // Tracé de référence inexploitable ou affinage en échec : tracé grossier.
  const withCoarseTrack = () => routeWithAnchors(base, userPoints, routeLegs, signal, anchorOptions);

  const coarse = referenceTrack ? null : await routeCoarse(base, routeLegs, signal);
  const anchoredVia = buildAnchoredVia(userPoints, referenceTrack ?? coarse!.route.coordinates, anchorOptions);
  if (!anchoredVia) return coarse ?? withCoarseTrack();

  let refined: RoutedLegs;
  try {
    refined = await routeAnchoredHalves({ ...base, via: anchoredVia }, routeLegs);
  } catch (error) {
    if (!canEscalate(error, signal)) throw error;
    return coarse ?? withCoarseTrack();
  }
  if (!coarse) return refined;
  // Le tracé grossier passe par les ancres : l'affinage ne doit jamais faire pire.
  const refinedCost = routeCost(refined.route);
  const coarseCost = routeCost(coarse.route);
  if (Number.isFinite(refinedCost) && Number.isFinite(coarseCost) && refinedCost > coarseCost) return coarse;
  return { ...refined, warnings: [...coarse.warnings, ...refined.warnings] };
}

/** Tracé grossier ; s'il n'aboutit pas, second essai encore plus glouton (même profil). */
async function routeCoarse(base: RouteRequestBase, routeLegs: RouteLegs, signal: AbortSignal): Promise<RoutedLegs> {
  try {
    return await routeLegs({ ...base, searchWeight: COARSE_SEARCH_WEIGHT });
  } catch (error) {
    if (!canEscalate(error, signal)) throw error;
    console.warn('[BRouter] coarse search failed, retrying greedier', error);
    return routeLegs({ ...base, searchWeight: GREEDY_COARSE_SEARCH_WEIGHT });
  }
}

/**
 * Tronçons ancrés en deux moitiés calculées en parallèle (2 threads BRouter) :
 * BRouter enchaîne les tronçons d'une requête l'un après l'autre, et un
 * tracé de 1 000 km en compte 6 à 8.
 */
async function routeAnchoredHalves(request: RouteRequestBase, routeLegs: RouteLegs): Promise<RoutedLegs> {
  const via = request.via ?? [];
  if (via.length < 3) return routeLegs(request);
  const mid = Math.floor(via.length / 2);
  const [first, second] = await Promise.all([
    routeLegs({ ...request, via: via.slice(0, mid), end: via[mid]! }, { start: true, end: false }),
    routeLegs({ ...request, start: via[mid]!, via: via.slice(mid + 1) }, { start: false, end: true }),
  ]);
  return {
    route: concatBrouterRoutes([first.route, second.route]),
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
  resolved: ResolvedRouting,
  signal: AbortSignal,
  ends: LegEnds = { start: true, end: true },
): Promise<RoutedLegs> {
  // Trop de via pour une requête : tronçons consécutifs routés l'un après
  // l'autre puis recollés, au lieu d'ignorer les via au-delà du plafond.
  const legs = splitRouteIntoLegs(request.start, request.via ?? [], request.end);
  const legRoutes: BrouterRoute[] = [];
  const warnings: string[] = [];

  const fetchLeg = (leg: BrouterLeg) => fetchCustomProfileRoute({ ...request, ...leg }, resolved.profileId);

  for (const [legIndex, leg] of legs.entries()) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const t0 = Date.now();
    let legRoute: BrouterRoute;
    try {
      legRoute = await fetchLeg(leg);
    } catch (error) {
      if (!isBrouterIslandError(error) || signal.aborted) throw error;
      // Point accroché à un îlot du graphe : on le décale vers son voisin.
      const repaired = Date.now() - t0 <= ISLAND_REPAIR_MAX_FAILURE_MS
        ? await repairIslandLeg(leg, error, fetchLeg, signal)
        : null;
      if (!repaired) throw error;
      const points = [leg.start, ...leg.via, leg.end];
      warnings.push(islandWarning(
        ends.start && legIndex === 0 && repaired.movedIndex === 0,
        ends.end && legIndex === legs.length - 1 && repaired.movedIndex === points.length - 1,
        repaired.movedM,
      ));
      legRoute = repaired.result;
    }
    legRoutes.push(legRoute);
  }
  return { route: concatBrouterRoutes(legRoutes), warnings };
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
