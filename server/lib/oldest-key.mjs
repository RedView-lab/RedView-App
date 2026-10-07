// ---------------------------------------------------------------------------
// Plus ancienne clé d'une Map (ordre d'insertion) en O(1) amorti, pour les
// structures bornées qui évincent en tête : rate limiter (server/lib/http-security.mjs),
// caches LRU en octets (server/lib/byte-lru.mjs).
//
// `map.keys().next()` repart du début de la table à chaque appel, et V8 y
// garde les entrées supprimées (des trous) jusqu'au prochain rehash :
// l'itérateur les saute une à une. Une Map pleine qui évince en tête payait
// ainsi ~10 µs par éviction à 50 000 clés (0,1 µs pour une insertion sans
// éviction). Un itérateur gardé d'un appel à l'autre ne repasse jamais sur une
// entrée : les itérateurs de Map voient les entrées ajoutées après leur
// création et sautent celles supprimées (ECMAScript), il désigne donc toujours
// la plus ancienne clé encore présente — mêmes clés évincées, même ordre.
// ---------------------------------------------------------------------------

/**
 * Lecteur de la plus ancienne clé de `map`. Contrat : l'appelant supprime
 * aussitôt la clé rendue (sinon elle ne serait plus jamais rendue en tête).
 *
 * @template K
 * @param {Map<K, unknown>} map
 * @returns {() => K | undefined} undefined si la Map est vide
 */
export function createOldestKeyTaker(map) {
  /** @type {IterableIterator<K> | null} */
  let cursor = null;
  return function takeOldestKey() {
    for (;;) {
      cursor ??= map.keys();
      const step = cursor.next();
      if (!step.done) return step.value;
      // Un itérateur arrivé au bout le reste pour toujours : on en reprend un.
      cursor = null;
      if (map.size === 0) return undefined;
    }
  };
}
