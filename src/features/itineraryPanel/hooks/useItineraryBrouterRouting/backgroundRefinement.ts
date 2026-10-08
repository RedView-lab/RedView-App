import type { BrouterRoute } from '../../lib/brouter';
import { refineRouteProfileWithIgnAltimetry, type RouteProfilePoint } from '../../lib/route-metrics';
import type { ItineraryProject } from '../../types';
import { applyRefinedRouteProfile, type RouteRefinementBase } from './projectMutations';

/** Profil altimétrique MNT d'un tracé, null en cas d'annulation ou d'échec (journalisé). */
async function resolveIgnAltimetryRouteProfile(route: BrouterRoute, signal: AbortSignal, reason: string) {
  if (signal.aborted) return null;
  try {
    return await refineRouteProfileWithIgnAltimetry(route, signal);
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') return null;
    console.warn(`[BRouter] ${reason}: IGN altimetry refinement failed`, error);
    return null;
  }
}

/**
 * Affinage altimétrique MNT (IGN 1 m en France, Copernicus ailleurs) d'un
 * tracé tout juste appliqué, en arrière-plan. Le résultat se rattache au
 * tracé affiné (cf. applyRefinedRouteProfile), pas à l'édition en attente
 * déjà effacée par la 1re application. Un nouvel affinage du même itinéraire
 * annule le précédent (`refinements`, contrôleur par itinéraire).
 */
export function startBackgroundRefinement(
  refinements: Map<string, AbortController>,
  setProject: (updater: (project: ItineraryProject) => ItineraryProject) => void,
  itineraryId: string,
  route: BrouterRoute,
  baseBox: { current: RouteRefinementBase | null },
  applyWithProfile: (project: ItineraryProject, profile: RouteProfilePoint[]) => ItineraryProject,
  reason: string,
): void {
  if (route.distanceM > 500_000) return;
  refinements.get(itineraryId)?.abort();
  const ctrl = new AbortController();
  refinements.set(itineraryId, ctrl);
  void resolveIgnAltimetryRouteProfile(route, ctrl.signal, reason).then((profile) => {
    if (refinements.get(itineraryId) === ctrl) refinements.delete(itineraryId);
    const base = baseBox.current;
    if (!profile || ctrl.signal.aborted || !base) return;
    setProject((project) => applyRefinedRouteProfile(
      project,
      base,
      (baseProject) => applyWithProfile(baseProject, profile),
    ));
  });
}
