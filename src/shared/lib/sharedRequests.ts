/**
 * Requêtes partagées par clé : les appelants simultanés d'une même clé
 * attendent une seule requête, annulée seulement quand tous l'ont abandonnée.
 * Chaque appelant garde son propre signal : le sien annulé, il reçoit
 * `AbortError` tout de suite, sans toucher aux autres.
 *
 * Partager une promesse lancée avec le signal du PREMIER appelant faisait
 * échouer les suivants quand celui-ci abandonnait — un effet React relancé
 * annule le précédent puis reprend aussitôt sa requête en vol (météo du tracé
 * « indisponible », vent bloqué « en chargement », recherche de lieux vide).
 */

interface SharedRequestOptions<E> {
  signal?: AbortSignal;
  /** Événements de la requête partagée (progression), relayés à cet appelant tant qu'il attend. */
  onEvent?: (event: E) => void;
}

export interface SharedRequests<T, E = never> {
  /**
   * Résultat de la requête de `key`, lancée par `start` si aucune n'est en
   * vol. `start` reçoit le signal de la requête partagée (jamais celui d'un
   * appelant) et de quoi émettre des événements vers tous les appelants.
   */
  run(
    key: string,
    start: (signal: AbortSignal, emit: (event: E) => void) => Promise<T>,
    options?: SharedRequestOptions<E>,
  ): Promise<T>;
  /** Une requête est-elle en vol pour cette clé ? */
  has(key: string): boolean;
}

interface SharedEntry<T, E> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
  listeners: Set<(event: E) => void>;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

export function createSharedRequests<T, E = never>(): SharedRequests<T, E> {
  const entries = new Map<string, SharedEntry<T, E>>();

  function join(key: string, entry: SharedEntry<T, E>, { signal, onEvent }: SharedRequestOptions<E>): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    entry.waiters += 1;
    if (onEvent) entry.listeners.add(onEvent);
    return new Promise<T>((resolve, reject) => {
      const detach = () => {
        signal?.removeEventListener('abort', leave);
        if (onEvent) entry.listeners.delete(onEvent);
      };
      function leave() {
        detach();
        reject(abortError());
        entry.waiters -= 1;
        if (entry.waiters > 0) return;
        // Plus personne ne l'attend : annulée, et retirée tout de suite pour
        // qu'un nouvel appelant reparte d'une requête neuve.
        if (entries.get(key) === entry) entries.delete(key);
        entry.controller.abort();
      }
      signal?.addEventListener('abort', leave, { once: true });
      entry.promise.then(
        (value) => {
          detach();
          resolve(value);
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
    });
  }

  return {
    run(key, start, options = {}) {
      const existing = entries.get(key);
      if (existing) return join(key, existing, options);
      if (options.signal?.aborted) return Promise.reject(abortError());

      const controller = new AbortController();
      // Le premier appelant écoute dès le départ : `start` peut émettre tout de suite.
      const listeners = new Set<(event: E) => void>(options.onEvent ? [options.onEvent] : []);
      const emit = (event: E) => {
        for (const listener of listeners) listener(event);
      };
      let promise: Promise<T>;
      try {
        promise = start(controller.signal, emit);
      } catch (error) {
        return Promise.reject(error);
      }
      const entry: SharedEntry<T, E> = { promise, controller, waiters: 0, listeners };
      entries.set(key, entry);
      promise
        .finally(() => {
          if (entries.get(key) === entry) entries.delete(key);
        })
        .catch(() => undefined); // l'erreur parvient aux appelants (join)
      return join(key, entry, options);
    },
    has: (key) => entries.has(key),
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
