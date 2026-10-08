// ============================================
// Outils du viewer LiDAR — API publique
// ============================================
//
// Menu du clic droit, mesures (distance, hauteur/angle, surface, profil) et
// analyses de terrain de montagne (ligne de chute, exposition aux avalanches,
// champ de vision) du viewer WebGPU. Voir controller.ts pour le modèle d'entrée.

import { computePointFilterBitmasks, type ViewerPointFilterState } from '../pointFilter';

export { ViewerToolsController,  } from './controller';

/** Prédicat de visibilité des classes, conforme au filtre de points du renderer. */
export function pointFilterClassPredicate(state: ViewerPointFilterState): (classification: number) => boolean {
  if (!state.enabled) return () => true;
  const masks = computePointFilterBitmasks(state.enabled, state.categories);
  return (classification) => classification >= 128 || ((masks[classification >> 5]! >>> (classification & 31)) & 1) === 1;
}
