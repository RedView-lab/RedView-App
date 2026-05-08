export const MAP_CACHE_EPOCH = '2026-05-08-slope-cancel-3';

export const MAP_CACHE_EPOCH_STORAGE_KEY = 'redview:map-cache-epoch';
export const PROJECT_CACHE_KEY_PREFIX_BASE = 'redview:project-cache:';
export const PROJECT_CACHE_KEY_PREFIX = `${PROJECT_CACHE_KEY_PREFIX_BASE}${MAP_CACHE_EPOCH}:`;

const MAP_CACHE_PREFIXES = [
  'dem-tiles-',
  'dem-negative-',
  'ortho-tiles-',
  'slope-tiles-',
  'altitude-tiles-',
  'shadow-tiles-',
  'dem-static-',
] as const;

function isManagedMapCacheName(cacheName: string): boolean {
  return MAP_CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
}

async function purgeBrowserManagedMapCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in globalThis)) return;
  try {
    const cacheNames = await globalThis.caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => isManagedMapCacheName(cacheName))
        .map((cacheName) => globalThis.caches.delete(cacheName)),
    );
  } catch (error) {
    console.warn('[map-cache] browser cache purge failed', error);
  }
}

function purgeLegacyMapLocalStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (
        key.startsWith(PROJECT_CACHE_KEY_PREFIX_BASE)
        && !key.startsWith(PROJECT_CACHE_KEY_PREFIX)
      ) {
        window.localStorage.removeItem(key);
        continue;
      }
    }
  } catch (error) {
    console.warn('[map-cache] localStorage purge failed', error);
  }
}

export async function ensureMapCacheEpochReset(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  try {
    const currentEpoch = window.localStorage.getItem(MAP_CACHE_EPOCH_STORAGE_KEY);
    if (currentEpoch === MAP_CACHE_EPOCH) return false;

    await purgeBrowserManagedMapCaches();
    purgeLegacyMapLocalStorage();
    window.localStorage.setItem(MAP_CACHE_EPOCH_STORAGE_KEY, MAP_CACHE_EPOCH);
    return true;
  } catch (error) {
    console.warn('[map-cache] epoch reset failed', error);
    return false;
  }
}