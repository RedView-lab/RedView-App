import { useState } from 'react';

/**
 * `value` telle qu'elle était au rendu où `keys` a changé pour la dernière fois
 * (comparées une à une avec `Object.is`) : les rendus suivants renvoient ce
 * même objet même s'ils en construisent un nouveau, jusqu'à ce qu'une clé
 * change.
 *
 * Pour un objet dont l'identité pilote un effet et doit suivre une notion de
 * changement plus étroite que ses propres champs (p. ex. une liste d'envois
 * comparée par sa signature). Contrairement à `useMemo`, dont React peut jeter
 * le cache, l'identité est garantie. Stockée comme état (« information des
 * rendus précédents ») : le rendu où une clé change est relancé une fois par
 * React avant ses enfants.
 */
export function useKeyedValue<T>(value: T, keys: readonly unknown[]): T {
  const [entry, setEntry] = useState(() => ({ value, keys }));
  if (sameKeys(entry.keys, keys)) return entry.value;
  setEntry({ value, keys });
  return value;
}

function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((key, index) => Object.is(key, b[index]));
}
