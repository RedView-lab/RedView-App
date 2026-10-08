/**
 * Détection du mode chercheur de montées (vallonné max).
 *
 * Reprend la logique de `brf-template.ts` : le curseur Dénivelé active le
 * « mode grimpeur » au-delà de 70 (sElev > 0.4). Dans ce régime, le BRF généré
 * gonfle les costfactors des routes plates et abaisse les seuils, ET la couche
 * de routage lance une recherche de N variantes pour garder celle qui grimpe le plus.
 *
 * Source unique de vérité pour que le conteneur du panneau, le banc de test et
 * le générateur de BRF ne puissent pas diverger.
 */
import type { PrioritiesState } from '../../../types';

/** Seuil du curseur au-delà duquel on passe au routage à variantes multiples. */
const CLIMBING_SLIDER_THRESHOLD = 70;

/**
 * `true` quand le curseur d'altitude est assez haut pour :
 *  1. émettre le BRF du mode grimpeur (seuils bas + gonflement climb_mul des routes),
 *  2. lancer N variantes de tracé et garder la plus raide.
 */
export function isClimbingMode(priorities: PrioritiesState): boolean {
  return priorities.elevation > CLIMBING_SLIDER_THRESHOLD;
}
