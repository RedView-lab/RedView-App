/**
 * Ordre d'empilement des tracés : l'itinéraire sélectionné est dessiné
 * par-dessus les autres (variantes superposées, croisements).
 *
 * Calcul pur sur l'ordre des couches du style : renvoie les déplacements
 * `moveLayer(layerId, beforeId)` nécessaires, et aucun quand l'ordre est déjà
 * bon — un `moveLayer` qui ne change rien salit quand même le style
 * (`styledata`, cache de drapé du terrain vidé).
 */
export interface RouteLayerMove {
  layerId: string;
  beforeId: string;
}

export function planActiveRouteRestack(
  order: readonly string[],
  activeLayerIds: ReadonlySet<string>,
  otherLayerIds: ReadonlySet<string>,
): RouteLayerMove[] {
  let activeFirstIndex = -1;
  for (let index = 0; index < order.length; index += 1) {
    if (activeLayerIds.has(order[index]!)) {
      activeFirstIndex = index;
      break;
    }
  }
  if (activeFirstIndex < 0) return [];

  // Couches des autres tracés au-dessus de la première couche du tracé actif :
  // replacées juste en dessous, dans leur ordre actuel (leur empilement
  // relatif est conservé). Les autres couches du style ne bougent pas.
  const beforeId = order[activeFirstIndex]!;
  const moves: RouteLayerMove[] = [];
  for (let index = activeFirstIndex + 1; index < order.length; index += 1) {
    const layerId = order[index]!;
    if (otherLayerIds.has(layerId)) moves.push({ layerId, beforeId });
  }
  return moves;
}
