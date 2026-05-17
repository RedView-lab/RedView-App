import { APP_CACHE_EPOCH, ensureAppCacheEpochReset } from '@/shared/lib/appCacheEpoch';

export const MAP_CACHE_EPOCH = APP_CACHE_EPOCH;
export const MAP_CACHE_EPOCH_STORAGE_KEY = 'redview:app-cache-epoch';
export const PROJECT_CACHE_KEY_PREFIX_BASE = 'redview:project-cache:';
export const PROJECT_CACHE_KEY_PREFIX = `${PROJECT_CACHE_KEY_PREFIX_BASE}${MAP_CACHE_EPOCH}:`;

export async function ensureMapCacheEpochReset(): Promise<boolean> {
  return ensureAppCacheEpochReset();
}