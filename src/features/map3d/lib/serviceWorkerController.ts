import { MAP_CACHE_EPOCH } from './mapCacheEpoch';

/** Époque de cache d'un worker, lue dans l'URL de son script (`?rv-map-cache-epoch=`). */
export function getServiceWorkerEpoch(serviceWorker: ServiceWorker | null | undefined): string | null {
  if (!serviceWorker?.scriptURL) return null;
  try {
    return new URL(serviceWorker.scriptURL).searchParams.get('rv-map-cache-epoch');
  } catch {
    return null;
  }
}

/**
 * Le Service Worker qui contrôle la page vient-il de ce build ? Après un
 * déploiement, la page peut tourner un moment sous le worker précédent, le
 * temps que le nouveau s'installe et la prenne (`controllerchange`) — voire
 * jusqu'au prochain chargement quand son rechargement unique a déjà eu lieu.
 * Ses routes statiques ignorent une famille de tuiles ajoutée depuis
 * (/contour-tiles le 2026-10-10), dont les requêtes partent alors au serveur,
 * qui répond 204 : courbes de niveau absentes jusqu'à un rechargement manuel.
 */
export function isServiceWorkerControllerCurrent(): boolean {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return false;
  return getServiceWorkerEpoch(navigator.serviceWorker.controller) === MAP_CACHE_EPOCH;
}

/** Abonnement aux changements de contrôleur (`useSyncExternalStore`). */
export function subscribeServiceWorkerController(listener: () => void): () => void {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!container) return () => undefined;
  container.addEventListener('controllerchange', listener);
  return () => container.removeEventListener('controllerchange', listener);
}
