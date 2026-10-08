import { useState } from 'react';

/**
 * Vrai au rendu où `value` diffère (`Object.is`) de celle du rendu précédent,
 * faux au premier rendu et tant qu'elle ne change pas.
 *
 * Pour « ajuster l'état quand une prop change » pendant le rendu, comme le
 * recommande React, au lieu d'un effet qui pose l'état après le commit (un
 * rendu de plus avec l'état périmé à l'écran,
 * react-hooks/set-state-in-effect) :
 *
 *   const canEditChanged = useHasChanged(canEdit);
 *   if (canEditChanged && !canEdit) setArmed(false);
 *
 * La valeur précédente est un état : sur un changement, React relance aussitôt
 * le rendu, avant les enfants, et le rendu suivant ne voit plus de changement.
 */
export function useHasChanged<T>(value: T): boolean {
  // Initialiseur et mise à jour fléchés : une fonction passée en valeur (p. ex.
  // `t`) serait sinon appelée par useState comme initialiseur / mise à jour.
  const [previous, setPrevious] = useState(() => value);
  if (Object.is(previous, value)) return false;
  setPrevious(() => value);
  return true;
}
