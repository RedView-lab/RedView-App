const APP_CACHE_FIX_EPOCH = '2026-05-17-cache-fixes-1';

export const APP_CACHE_EPOCH = `${__REDVIEW_BUILD_ID__}:${APP_CACHE_FIX_EPOCH}`;
export const APP_CACHE_EPOCH_STORAGE_KEY = 'redview:app-cache-epoch';

const BROWSER_CACHE_PREFIXES = [
  'dem-tiles-',
  'dem-negative-',
  'ortho-tiles-',
  'slope-tiles-',
  'altitude-tiles-',
  'shadow-tiles-',
  'dem-static-',
] as const;

const LOCAL_STORAGE_CACHE_PREFIXES = [
  'poi_cache_',
  'redview:project-cache:',
  'redview:subscription-status:',
] as const;

const SESSION_STORAGE_CACHE_PREFIXES = [
  'redview:map-cache-auto-reload',
] as const;

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

async function purgeManagedBrowserCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in globalThis)) return;
  try {
    const cacheNames = await globalThis.caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => startsWithAny(cacheName, BROWSER_CACHE_PREFIXES))
        .map((cacheName) => globalThis.caches.delete(cacheName)),
    );
  } catch (error) {
    console.warn('[app-cache] browser cache purge failed', error);
  }
}

function purgeManagedStorage(storage: Storage, prefixes: readonly string[]): void {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || !startsWithAny(key, prefixes)) continue;
    storage.removeItem(key);
  }
}

function purgeManagedLocalStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    purgeManagedStorage(window.localStorage, LOCAL_STORAGE_CACHE_PREFIXES);
  } catch (error) {
    console.warn('[app-cache] localStorage purge failed', error);
  }
}

function purgeManagedSessionStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    purgeManagedStorage(window.sessionStorage, SESSION_STORAGE_CACHE_PREFIXES);
  } catch (error) {
    console.warn('[app-cache] sessionStorage purge failed', error);
  }
}

export async function ensureAppCacheEpochReset(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  try {
    const currentEpoch = window.localStorage.getItem(APP_CACHE_EPOCH_STORAGE_KEY);
    if (currentEpoch === APP_CACHE_EPOCH) return false;

    purgeManagedLocalStorage();
    purgeManagedSessionStorage();
    await purgeManagedBrowserCaches();
    window.localStorage.setItem(APP_CACHE_EPOCH_STORAGE_KEY, APP_CACHE_EPOCH);
    return true;
  } catch (error) {
    console.warn('[app-cache] epoch reset failed', error);
    return false;
  }
}