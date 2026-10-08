import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Réf qui contient toujours la valeur du dernier rendu validé, pour les
 * callbacks qui survivent au rendu (événements de carte, minuteurs, messages
 * de worker) et doivent lire les props courantes sans être recréés.
 *
 * Écrite dans un effet de layout, jamais pendant le rendu (react-hooks/refs) :
 * un rendu que React jette (rendu concurrent, seconde passe de StrictMode) n'y
 * fuit jamais. Les effets de layout s'exécutent avant tous les effets passifs
 * du même commit, donc les `useEffect` du composant et de ses enfants lisent
 * déjà la nouvelle valeur. Pas pour une lecture pendant le rendu : y utiliser
 * la valeur elle-même.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
