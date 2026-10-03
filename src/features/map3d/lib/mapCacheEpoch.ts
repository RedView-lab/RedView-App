import { APP_CACHE_EPOCH, APP_CACHE_FIX_EPOCH, ensureAppCacheEpochReset } from '@/shared/lib/appCacheEpoch';

export const MAP_CACHE_EPOCH = APP_CACHE_EPOCH;
/**
 * Époque des caches CacheStorage écrits par le Service Worker
 * (`dem-tiles-<epoch>`, public/sw-dem/core/config.js) : l'époque « fix » seule,
 * sans l'identifiant de build. Les workers qui lisent ces caches doivent
 * utiliser cette valeur, pas MAP_CACHE_EPOCH.
 */
export const SW_TILE_CACHE_EPOCH = APP_CACHE_FIX_EPOCH;
export const PROJECT_CACHE_KEY_PREFIX_BASE = 'redview:project-cache:';
export const PROJECT_CACHE_KEY_PREFIX = `${PROJECT_CACHE_KEY_PREFIX_BASE}${MAP_CACHE_EPOCH}:`;

export async function ensureMapCacheEpochReset(): Promise<boolean> {
  return ensureAppCacheEpochReset();
}