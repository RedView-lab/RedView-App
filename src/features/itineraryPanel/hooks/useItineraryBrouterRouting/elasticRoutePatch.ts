import type { Itinerary } from '../../types';
import {
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
 * Patch local sans point de passage fantôme. Les bornes d'une fenêtre locale
 * sont prises sur l'ancien tracé (cf. narrowRoutePatchToEdit) : quand
 * l'édition déplace le tracé loin de l'ancien, y forcer le nouveau le ferait
 * revenir en crochet. Chaque borne que le tracé obtenu ne rejoint pas en
 * suivant déjà l'ancien recule (fenêtre élargie, puis bornes réelles) et le
 * patch est rerouté ; seules les vraies étapes contraignent le tracé.
 *
 * Un élargissement qui échoue (délai, serveur) garde le tracé précédent,
 * valide mais moins naturel, plutôt que de perdre l'édition.
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
    const widened = widenUnjoinedRoutePatchWindow(current, storedPoints, resolved.route.coordinates);
    if (!widened) return routed;
    console.info('[BRouter] local patch: window bound not rejoined, widening', {
      start: widened.start.distanceM ?? widened.start.kind,
      end: widened.end.distanceM ?? widened.end.kind,
    });
    previous = routed;
    current = widened;
  }
}
