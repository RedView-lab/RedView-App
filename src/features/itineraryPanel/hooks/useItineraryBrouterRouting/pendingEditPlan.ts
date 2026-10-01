import type { Itinerary } from '../../types';

interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Édition locale envoyée à BRouter dont le résultat n'a pas encore été
 * appliqué au tracé stocké (requête en vol, annulée ou en échec).
 */
export interface UnresolvedRouteEdit {
  kind: 'append' | 'patch';
  /** `JSON.stringify` du champ pending demandé (extension ou patch). */
  pendingKey: string;
  /** Ajout : segment réellement demandé (clics non encore routés fusionnés). */
  append?: { from: LatLon; via: LatLon[]; to: LatLon };
}

export type PendingEditPlan =
  | { mode: 'none' }
  | { mode: 'patch'; pendingKey: string }
  | { mode: 'append'; pendingKey: string; from: LatLon; via: LatLon[]; to: LatLon }
  /** Une édition non routée a été remplacée par une autre : tracé complet à recalculer. */
  | { mode: 'full' };

function sameLatLon(a: LatLon, b: LatLon): boolean {
  return a.lat === b.lat && a.lon === b.lon;
}

/**
 * Décide comment router l'édition en attente d'un itinéraire, sachant qu'une
 * édition précédente peut ne pas avoir été appliquée.
 *
 * Avant, la nouvelle édition écrasait simplement l'ancienne : la requête en vol
 * était annulée, seul le dernier segment était routé, et le morceau de l'édition
 * perdue restait une ligne droite marquée comme routée (jamais réparée).
 *
 *  - clics successifs du traceur : l'extension repart du dernier point routé
 *    et passe par tous les clics intermédiaires (via) ;
 *  - tout autre enchaînement (deux déplacements, déplacement pendant un
 *    ajout…) : recalcul complet du tracé, seul résultat sûr.
 */
export function planPendingRouteEdit(
  itinerary: Itinerary | null | undefined,
  unresolved: UnresolvedRouteEdit | undefined,
): PendingEditPlan {
  if (!itinerary) return { mode: 'none' };

  const patch = itinerary.pendingRoutePatch;
  if (patch) {
    const pendingKey = JSON.stringify(patch);
    if (unresolved && unresolved.pendingKey !== pendingKey) return { mode: 'full' };
    return { mode: 'patch', pendingKey };
  }

  const extension = itinerary.pendingTraceExtension;
  if (extension) {
    const pendingKey = JSON.stringify(extension);
    if (!unresolved) {
      return { mode: 'append', pendingKey, from: extension.from, via: [], to: extension.to };
    }
    if (unresolved.kind === 'append' && unresolved.append) {
      if (unresolved.pendingKey === pendingKey) {
        return { mode: 'append', pendingKey, ...unresolved.append };
      }
      if (sameLatLon(unresolved.append.to, extension.from)) {
        return {
          mode: 'append',
          pendingKey,
          from: unresolved.append.from,
          via: [...unresolved.append.via, unresolved.append.to],
          to: extension.to,
        };
      }
    }
    return { mode: 'full' };
  }

  // Édition non routée puis effacée sans résultat : le tracé stocké est périmé.
  return unresolved ? { mode: 'full' } : { mode: 'none' };
}
