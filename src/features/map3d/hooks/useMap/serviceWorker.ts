import {
  SW_CONTROLLER_TIMEOUT,
} from './constants';
import { ensureMapCacheEpochReset, MAP_CACHE_EPOCH } from '../../lib/mapCacheEpoch';

const MAP_CACHE_AUTO_RELOAD_SESSION_KEY = 'redview:map-cache-auto-reload';

function getServiceWorkerEpoch(serviceWorker: ServiceWorker | null | undefined): string | null {
  if (!serviceWorker?.scriptURL) return null;
  try {
    return new URL(serviceWorker.scriptURL).searchParams.get('rv-map-cache-epoch');
  } catch {
    return null;
  }
}

function hasReloadedForCurrentEpoch(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(MAP_CACHE_AUTO_RELOAD_SESSION_KEY) === MAP_CACHE_EPOCH;
  } catch {
    return false;
  }
}

function markReloadedForCurrentEpoch(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(MAP_CACHE_AUTO_RELOAD_SESSION_KEY, MAP_CACHE_EPOCH);
  } catch {
    /* ignore storage failures */
  }
}

function scheduleEpochTakeoverReload(epochReset: boolean): void {
  if (!epochReset || typeof window === 'undefined' || hasReloadedForCurrentEpoch()) return;

  let reloaded = false;
  const reloadOnce = (reason: string) => {
    if (reloaded || hasReloadedForCurrentEpoch()) return;
    reloaded = true;
    markReloadedForCurrentEpoch();
    console.warn(`[sw-dem] map cache epoch changed; reloading page once (${reason})`);
    window.location.reload();
  };

  const currentEpoch = getServiceWorkerEpoch(navigator.serviceWorker.controller);
  if (currentEpoch === MAP_CACHE_EPOCH) {
    reloadOnce('controller already updated');
    return;
  }

  const onControllerChange = () => {
    if (getServiceWorkerEpoch(navigator.serviceWorker.controller) !== MAP_CACHE_EPOCH) return;
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    clearTimeout(fallbackTimer);
    reloadOnce('controllerchange');
  };

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  const fallbackTimer = window.setTimeout(() => {
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    reloadOnce('takeover timeout');
  }, 2500);
}

function notifyMapCacheReset(serviceWorker: ServiceWorker | null | undefined): void {
  serviceWorker?.postMessage({
    type: 'PURGE_MAP_CACHES',
    epoch: MAP_CACHE_EPOCH,
  });
}

function notifyRegistrationMapCacheReset(
  registration: ServiceWorkerRegistration | null | undefined,
): void {
  if (!registration) return;
  notifyMapCacheReset(registration.installing);
  notifyMapCacheReset(registration.waiting);
  notifyMapCacheReset(registration.active);
}

async function waitForServiceWorkerController(timeoutMs: number): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;

  return await new Promise<ServiceWorker | null>((resolve) => {
    let settled = false;
    const finish = (controller: ServiceWorker | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      resolve(controller);
    };

    const onControllerChange = () => finish(navigator.serviceWorker.controller);
    const timer = setTimeout(() => finish(navigator.serviceWorker.controller), timeoutMs);

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  });
}

/**
 * Primary bootstrap promise — resolves `true` within SW_CONTROLLER_TIMEOUT
 * if the SW controller is available, `false` otherwise.
 *
 * The page-side bootstrap uses this to decide the initial path (fast SW or
 * plain-Mapbox fallback). Even when this resolves `false`, the SW may still
 * claim slightly later — see `swLateReady` below.
 */
export const swReady: Promise<boolean> = (async () => {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const epochReset = await ensureMapCacheEpochReset();
    const registration = await navigator.serviceWorker.register(
      `/sw-dem.js?rv-map-cache-epoch=${encodeURIComponent(MAP_CACHE_EPOCH)}`,
      { scope: '/' },
    );

    if (epochReset) {
      notifyRegistrationMapCacheReset(registration);
      notifyMapCacheReset(navigator.serviceWorker.controller);
      scheduleEpochTakeoverReload(true);
    }

    const controller = await waitForServiceWorkerController(SW_CONTROLLER_TIMEOUT);
    if (!controller) {
      console.warn('[sw-dem] No controller after registration timeout - proceeding without DEM enhancement');
      return false;
    }

    if (epochReset) {
      notifyMapCacheReset(controller);
    }

    return true;
  } catch (error) {
    console.error('[sw-dem] Registration failed:', error);
    return false;
  }
})();

/**
 * Late-SW recovery promise. When `swReady` resolves `false` (controller
 * wasn't available within 2.5 s), this promise keeps polling for up to
 * 20 s. If the controller appears later, the bootstrap can re-trigger
 * the full DEM pipeline instead of staying flat forever.
 *
 * Resolves `true` if the controller eventually appeared, `false` if not.
 */
export const swLateReady: Promise<boolean> = (async () => {
  const fast = await swReady;
  if (fast) return true; // already ready, no need for late path

  if (!('serviceWorker' in navigator)) return false;

  // The SW registration succeeded (swReady didn't throw) but the
  // controller wasn't claimed in time. Poll for up to 20 s with
  // increasing back-off. The SW activate handler calls
  // `self.clients.claim()` which fires `controllerchange`.
  const MAX_LATE_WAIT_MS = 20_000;
  const start = Date.now();
  let interval = 200;

  while (Date.now() - start < MAX_LATE_WAIT_MS) {
    await new Promise<void>((r) => setTimeout(r, interval));
    if (navigator.serviceWorker.controller) {
      console.log('[sw-dem] Late controller claim detected — DEM pipeline can recover');
      return true;
    }
    interval = Math.min(interval * 1.5, 2000);
  }

  console.warn('[sw-dem] Controller never appeared within late-recovery window');
  return false;
})();

/**
 * Event-driven controller wait. If the SW controller is already
 * present, resolves immediately with `true`. Otherwise listens for
 * `controllerchange` for up to `timeoutMs` ms and resolves `true` as
 * soon as the controller appears, `false` if the timeout fires first.
 *
 * Use this at bootstrap time to bridge the install/activate window:
 * the cached `swReady` promise has a 2.5 s budget at module-load time,
 * which is too short for cold installs on slow networks. Re-checking
 * here prevents the "SW unavailable → AWS Terrarium fallback" warning
 * when the controller is actually moments away from claiming.
 */
export function awaitController(timeoutMs: number): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(false);
  }
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      clearTimeout(timer);
      resolve(ok);
    };
    const onChange = () => {
      if (navigator.serviceWorker.controller) finish(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    const timer = setTimeout(() => finish(!!navigator.serviceWorker.controller), timeoutMs);
  });
}