import { RouteSeamError } from '../../lib/routes';
import type { Itinerary } from '../../types';
import {
  planRouteSplice,
  widenUnjoinedRoutePatchWindow,
  type RoutePoints,
} from '../useItineraryBrouterRoutingShared';

import type { ResolvedRouteRequest } from './resolveRouteRequest';

type RoutePatch = NonNullable<Itinerary['pendingRoutePatch']>;

export interface ResolvedRoutePatch extends ResolvedRouteRequest {
  /** Bornes réellement routées : la fenêtre locale a pu être élargie. */
  patch: RoutePatch;
}

/**
 * Patch local sans point de passage fantôme ni ligne droite. Les bornes d'une
 * fenêtre locale sont prises sur l'ancien tracé (cf. narrowRoutePatchToEdit) :
 * quand l'édition déplace le tracé loin de l'ancien, y forcer le nouveau le
 * ferait revenir en crochet. Chaque borne que le tracé obtenu ne rejoint pas
 * en suivant déjà l'ancien — ou dont la jonction avec l'ancien tracerait une
 * ligne droite (cf. planRouteSplice) — recule (fenêtre élargie, puis bornes
 * réelles) et le patch est rerouté ; seules les vraies étapes contraignent le
 * tracé.
 *
 * Un élargissement qui échoue (délai, serveur) garde le tracé précédent,
 * valide mais moins naturel, plutôt que de perdre l'édition. Une jonction
 * impossible aux bornes réelles rejette `RouteSeamError` : l'appelant
 * recalcule tout le tracé au lieu d'y laisser une ligne droite.
 */
export async function resolveElasticRoutePatch(
  patch: RoutePatch,
  storedPoints: RoutePoints,
  signal: AbortSignal,
  routePatch: (patch: RoutePatch) => Promise<ResolvedRouteRequest>,
): Promise<ResolvedRoutePatch> {
  let current = patch;
  let previous: ResolvedRoutePatch | null = null;
  for (;;) {
    let resolved: ResolvedRouteRequest;
    try {
      resolved = await routePatch(current);
    } catch (error) {
      if (!previous || signal.aborted) throw error;
      console.warn('[BRouter] local patch: widened window failed, keeping the narrower route', error);
      return previous;
    }
    const routed: ResolvedRoutePatch = { ...resolved, patch: current };
    const coordinates = resolved.route.coordinates;
    const splice = planRouteSplice(storedPoints, current, coordinates.map(([lon, lat]) => ({ lat, lon })));
    const seamFailed = splice.ok
      ? {}
      : { start: splice.side !== 'end', end: splice.side !== 'start' };
    const widened = widenUnjoinedRoutePatchWindow(current, storedPoints, coordinates, seamFailed);
    if (!widened) {
      if (!splice.ok) throw new RouteSeamError(`local patch ${splice.side} bound`, splice.gapM);
      return routed;
    }
    console.info('[BRouter] local patch: window bound not rejoined, widening', {
      start: widened.start.distanceM ?? widened.start.kind,
      end: widened.end.distanceM ?? widened.end.kind,
      seam: splice.ok ? 'ok' : splice.side,
    });
    // Seul un tracé qui se recolle sans ligne droite peut servir de repli.
    if (splice.ok) previous = routed;
    current = widened;
  }
}
