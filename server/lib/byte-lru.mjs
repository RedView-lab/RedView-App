// ---------------------------------------------------------------------------
// Cache LRU borné en octets, partagé par `server.mjs`, les tuiles de secours
// (`server/lib/terrain-tiles.mjs`) et les routes `api/` (BRouter, météo,
// Météo-France).
//
// Une borne en nombre d'entrées ne suffit pas : une entrée va de quelques Ko
// (tuile) à plusieurs Mo (tracé, grille). Chaque cache déclare son budget, et
// le pire cas mémoire du processus est la somme des budgets (le conteneur a
// une limite mémoire : un cache sans borne en octets finit en OOM).
// ---------------------------------------------------------------------------

import { createOldestKeyTaker } from './oldest-key.mjs';

/**
 * @template V
 * @typedef {object} ByteLru
 * @property {(key: string) => V | undefined} get Valeur fraîche, remontée en tête (LRU) ; `undefined` si absente ou expirée.
 * @property {(key: string, value: V) => boolean} set Stocke la valeur ; `false` si elle dépasse la taille max d'une entrée (rien n'est gardé).
 * @property {(key: string) => void} delete
 * @property {() => void} clear
 * @property {number} size Nombre d'entrées.
 * @property {number} bytes Octets comptés (clés comprises).
 */

/**
 * @template V
 * @param {object} options
 * @param {number} options.maxBytes Budget total (octets).
 * @param {(value: V) => number} options.sizeOf Taille d'une valeur (octets).
 * @param {number} [options.ttlMs] Durée de vie d'une entrée ; sans elle, seule l'éviction LRU s'applique.
 * @param {number} [options.maxEntryBytes] Plus grosse entrée acceptée (défaut : un quart du budget).
 * @returns {ByteLru<V>}
 */
export function createByteLru({ maxBytes, sizeOf, ttlMs, maxEntryBytes = maxBytes / 4 }) {
  /** @type {Map<string, { value: V, bytes: number, expiresAt: number }>} */
  const entries = new Map();
  // Éviction en tête en O(1) amorti (server/lib/oldest-key.mjs).
  const takeOldestKey = createOldestKeyTaker(entries);
  let bytes = 0;

  /** @param {string} key */
  function drop(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        drop(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      drop(key);
      // Clés en ASCII (chemins, paramètres) : un octet par caractère.
      const entryBytes = sizeOf(value) + key.length;
      if (entryBytes > maxEntryBytes) return false;
      while (bytes + entryBytes > maxBytes && entries.size > 0) {
        drop(/** @type {string} */ (takeOldestKey()));
      }
      entries.set(key, { value, bytes: entryBytes, expiresAt: ttlMs ? Date.now() + ttlMs : Infinity });
      bytes += entryBytes;
      return true;
    },
    delete: drop,
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
