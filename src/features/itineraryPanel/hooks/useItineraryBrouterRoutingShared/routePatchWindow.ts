

import { haversineRouteDistanceM } from '../../lib/routes';
import { LOCAL_EDIT_WINDOW_KM } from '../../lib/brouter';

import type { RoutePoint, RoutePoints } from './types';
import { getRoutePointDistances, interpolateRoutePointAtDistance, type RoutePatch, type RoutePatchBoundary, type LatLon, routePatchBoundaryDistanceM, projectOnRouteRange, approxDistanceM, firstIndexAtOrAfter } from './routeGeometry';

/** Une fenêtre n'a d'intérêt que si elle épargne au moins ça de tracé. */
const MIN_WINDOW_GAIN_M = 20_000;
/** Distance sous laquelle le tracé « repasse » par la position éditée. */
const REVISIT_CLEARANCE_M = 1_000;
/** Écart toléré entre le kilométrage d'une ligne et les distances du tracé. */
const EDIT_POSITION_TOLERANCE_M = 5_000;
/**
 * Demi-fenêtres successives (m de tracé de part et d'autre de l'édition)
 * quand une borne n'est pas rejointe naturellement ; au-delà, borne réelle.
 * On commence petit : la plupart des éditions (point glissé, trace tirée) se
 * recollent à l'ancien tracé en quelques km, et le temps d'une recherche
 * BRouter croît bien plus vite que sa longueur — une fenêtre de ±80 km
 * d'emblée coûtait plusieurs secondes par glisser. Un cran raté ne coûte
 * qu'une recherche courte de plus.
 */
const WINDOW_STEPS_M = [12_000, LOCAL_EDIT_WINDOW_KM * 1_000, LOCAL_EDIT_WINDOW_KM * 2_500];
/** Tracé que le nouveau doit partager avec l'ancien juste avant une borne provisoire. */
const REJOIN_PROOF_M = 5_000;
/** Écart latéral sous lequel deux tracés suivent la même route (GPX bruité compris). */
const REJOIN_TOLERANCE_M = 60;
/** Part de `REJOIN_PROOF_M` à partager : absorbe les points GPS aberrants. */
const REJOIN_MIN_SHARE = 0.85;

function samePatchBound(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

export interface RoutePatchEdit {
  /** Portion du tracé stocké que l'édition invalide (m depuis le départ). */
  fromM: number;
  toM: number;
  /**
   * Position déduite d'une projection (kilométrage d'une ligne) : sur une
   * boucle ou un aller-retour, elle peut désigner le mauvais passage. La
   * fenêtre n'est alors posée que si le tracé ne repasse pas par là ailleurs.
   */
  projected: boolean;
}

/**
 * Fenêtre locale, même méthode que les ancres des très longs tracés appliquée
 * au tracé stocké. Un patch reroute tout le tronçon entre les lignes voisines
 * de l'édition — sur un tracé géant sans étape, tout le tracé. Le tracé stocké
 * étant déjà le meilleur pour ce profil, ses bornes sont rapprochées à
 * `LOCAL_EDIT_WINDOW_KM` de part et d'autre de la portion éditée, prises sur
 * le tracé lui-même : le reste est conservé tel quel, et la recherche reste
 * courte (pas de délai dépassé, heuristique peu gloutonne).
 *
 * Ces bornes sont provisoires (`window`) : le routage les recule quand le
 * nouveau tracé ne les rejoint pas en suivant déjà l'ancien (cf.
 * widenUnjoinedRoutePatchWindow), sinon elles deviendraient des points de
 * passage fantômes qui ramènent le tracé en crochet vers l'ancien.
 * Renvoie le patch inchangé quand il n'y a rien à gagner ou en cas de doute.
 */
export function narrowRoutePatchToEdit(
  patch: RoutePatch,
  routePoints: RoutePoints,
  edit: RoutePatchEdit,
): RoutePatch {
  return placeRoutePatchWindow(patch, routePoints, edit, WINDOW_STEPS_M[0]!, WINDOW_STEPS_M[0]!);
}

/**
 * Patch entre les bornes réelles de `outer`, restreint à `beforeM` / `afterM`
 * de tracé de part et d'autre de l'édition (`null` : borne réelle gardée).
 */
function placeRoutePatchWindow(
  outer: Pick<RoutePatch, 'start' | 'end' | 'via'>,
  routePoints: RoutePoints,
  edit: RoutePatchEdit,
  beforeM: number | null,
  afterM: number | null,
): RoutePatch {
  const real: RoutePatch = { start: outer.start, end: outer.end, via: outer.via };
  if (routePoints.length < 2) return real;
  const distances = getRoutePointDistances(routePoints);
  const startM = routePatchBoundaryDistanceM(real.start, routePoints, distances);
  const endM = routePatchBoundaryDistanceM(real.end, routePoints, distances);
  if (startM == null || endM == null || endM <= startM) return real;
  // Édition projetée hors du tronçon de ses voisines : autre passage, on ne touche à rien.
  if (edit.fromM < startM - EDIT_POSITION_TOLERANCE_M || edit.toM > endM + EDIT_POSITION_TOLERANCE_M) {
    return real;
  }
  const fromM = Math.min(endM, Math.max(startM, edit.fromM));
  const toM = Math.min(endM, Math.max(fromM, edit.toM));

  const startIndex = beforeM != null && fromM - beforeM > startM + MIN_WINDOW_GAIN_M
    ? Math.max(0, firstIndexAtOrAfter(distances, fromM - beforeM) - 1)
    : null;
  const endIndex = afterM != null && toM + afterM < endM - MIN_WINDOW_GAIN_M
    ? Math.min(routePoints.length - 1, firstIndexAtOrAfter(distances, toM + afterM))
    : null;
  if (startIndex == null && endIndex == null) return real;
  const windowStartM = startIndex != null ? distances[startIndex]! : startM;
  const windowEndM = endIndex != null ? distances[endIndex]! : endM;

  if (edit.projected) {
    const targets = [fromM, toM]
      .map((distanceM) => interpolateRoutePointAtDistance(routePoints, distances, distanceM))
      .filter((target): target is RoutePoint => target !== null);
    for (let index = 0; index < routePoints.length; index += 1) {
      const distanceM = distances[index]!;
      if (distanceM < startM || distanceM > endM) continue;
      if (distanceM >= windowStartM && distanceM <= windowEndM) continue;
      const point = routePoints[index]!;
      if (targets.some((target) => approxDistanceM(point, target) < REVISIT_CLEARANCE_M)) return real;
    }
  }

  const boundary = (index: number) => ({
    lat: routePoints[index]!.lat,
    lon: routePoints[index]!.lon,
    kind: 'waypoint' as const,
    distanceM: distances[index]!,
  });
  return {
    start: startIndex != null ? boundary(startIndex) : real.start,
    end: endIndex != null ? boundary(endIndex) : real.end,
    via: real.via,
    window: { start: real.start, end: real.end, fromM: edit.fromM, toM: edit.toM, projected: edit.projected },
  };
}

/**
 * Le nouveau tracé `route` atteint-il la borne provisoire `bound` en suivant
 * déjà l'ancien, dans son sens, sur `REJOIN_PROOF_M` ? Sinon la borne l'a
 * dévié : il y revient en crochet au lieu de rejoindre l'ancien là où il
 * l'aurait fait de lui-même.
 */
function routeRejoinsStoredTrackAt(
  route: LatLon[],
  routePoints: RoutePoints,
  distances: number[],
  bound: RoutePatchBoundary,
  side: 'start' | 'end',
): boolean {
  const boundM = routePatchBoundaryDistanceM(bound, routePoints, distances);
  if (boundM == null) return false;
  // Ancien tracé côté fenêtre, avec de la marge : le nouveau peut être plus long.
  const searchM = REJOIN_PROOF_M * 2;
  const rangeFromM = side === 'start' ? boundM : boundM - searchM;
  const rangeToM = side === 'start' ? boundM + searchM : boundM;
  // On parcourt le nouveau tracé depuis la borne, vers l'intérieur de la fenêtre.
  const at = (step: number) => route[side === 'start' ? step : route.length - 1 - step]!;
  let walkedM = 0;
  let sharedM = 0;
  let reachedM = 0;
  for (let step = 1; step < route.length && walkedM < REJOIN_PROOF_M; step += 1) {
    const stepM = haversineRouteDistanceM(at(step - 1), at(step));
    walkedM += stepM;
    const projection = projectOnRouteRange(at(step), routePoints, distances, rangeFromM, rangeToM, boundM);
    if (!projection || projection.offsetM > REJOIN_TOLERANCE_M) continue;
    // Même sens que l'ancien tracé : on s'éloigne de la borne en le suivant.
    const awayM = Math.abs(projection.alongM - boundM);
    if (awayM + REJOIN_TOLERANCE_M < reachedM) continue;
    reachedM = Math.max(reachedM, awayM);
    sharedM += stepM;
  }
  return walkedM > 0 && sharedM >= walkedM * REJOIN_MIN_SHARE;
}

/**
 * Après le routage d'une fenêtre locale (`route` en [lon, lat]) : chaque borne
 * provisoire que le nouveau tracé n'a pas rejointe naturellement recule d'un
 * cran (`WINDOW_STEPS_M`), puis jusqu'à la borne réelle. Une borne rejointe
 * reste en place. `null` : rien à élargir, le tracé est accepté.
 * `seamFailed` : côtés dont la jonction avec le tracé stocké a échoué (cf.
 * planRouteSplice), élargis de toute façon.
 */
export function widenUnjoinedRoutePatchWindow(
  patch: RoutePatch,
  routePoints: RoutePoints,
  route: [number, number][],
  seamFailed: { start?: boolean; end?: boolean } = {},
): RoutePatch | null {
  const { window } = patch;
  if (!window || routePoints.length < 2 || route.length < 2) return null;
  const distances = getRoutePointDistances(routePoints);
  const coords = route.map(([lon, lat]) => ({ lat, lon }));

  const startProvisional = !samePatchBound(patch.start, window.start);
  const endProvisional = !samePatchBound(patch.end, window.end);
  const widenStart = startProvisional
    && (seamFailed.start === true || !routeRejoinsStoredTrackAt(coords, routePoints, distances, patch.start, 'start'));
  const widenEnd = endProvisional
    && (seamFailed.end === true || !routeRejoinsStoredTrackAt(coords, routePoints, distances, patch.end, 'end'));
  if (!widenStart && !widenEnd) return null;

  const startM = routePatchBoundaryDistanceM(patch.start, routePoints, distances);
  const endM = routePatchBoundaryDistanceM(patch.end, routePoints, distances);
  const nextStepM = (currentM: number) => WINDOW_STEPS_M.find((stepM) => stepM > currentM + 1_000) ?? null;
  // Demi-fenêtre actuelle d'un côté : cran suivant s'il faut l'élargir, sinon inchangée.
  const sideM = (provisional: boolean, widen: boolean, currentM: number | null) => {
    if (!provisional || currentM == null) return null;
    return widen ? nextStepM(currentM) : currentM;
  };
  const widened = placeRoutePatchWindow(
    { start: window.start, end: window.end, via: patch.via },
    routePoints,
    window,
    sideM(startProvisional, widenStart, startM == null ? null : window.fromM - startM),
    sideM(endProvisional, widenEnd, endM == null ? null : endM - window.toM),
  );
  // Le côté rejoint garde exactement sa borne (pas de re-placement au point près).
  const next: RoutePatch = widened.window
    ? {
        ...widened,
        start: widenStart ? widened.start : patch.start,
        end: widenEnd ? widened.end : patch.end,
      }
    : widened;
  return samePatchBound(next.start, patch.start) && samePatchBound(next.end, patch.end) ? null : next;
}
