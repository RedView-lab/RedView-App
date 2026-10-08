export function dispatchRouteLoading(loading: boolean) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rv-route-loading', { detail: { loading } }));
  }
}

/**
 * « Calcul en cours » de l'itinéraire actif. C'est l'état du planificateur de
 * requêtes (minuteur d'anti-rebond, AbortController, jobs de patch : tous hors
 * React, en refs), pas un état dérivé du rendu : posé quand une requête est
 * programmée ou lancée — y compris par l'effet de routage — et levé quand elle
 * aboutit, échoue ou est annulée. Une seule source pour React
 * (useSyncExternalStore) et pour le curseur de la carte (`rv-route-loading`,
 * émis à chaque écriture comme avant, même valeur répétée comprise).
 */
interface RouteLoadingStore {
  get: () => boolean;
  subscribe: (listener: () => void) => () => void;
  set: (loading: boolean) => void;
}

export function createRouteLoadingStore(): RouteLoadingStore {
  let loading = false;
  const listeners = new Set<() => void>();
  return {
    get: () => loading,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      dispatchRouteLoading(next);
      if (next === loading) return;
      loading = next;
      for (const listener of listeners) listener();
    },
  };
}
