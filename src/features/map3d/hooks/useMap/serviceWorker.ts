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

function registrationHasTargetEpoch(
  registration: ServiceWorkerRegistration | null | undefined,
): boolean {
  if (!registration) return false;
  return getServiceWorkerEpoch(registration.installing) === MAP_CACHE_EPOCH
    || getServiceWorkerEpoch(registration.waiting) === MAP_CACHE_EPOCH
    || getServiceWorkerEpoch(registration.active) === MAP_CACHE_EPOCH;
}

function scheduleEpochTakeoverReload(
  registration: ServiceWorkerRegistration | null | undefined,
  epochReset: boolean,
): void {
  if (typeof window === 'undefined' || hasReloadedForCurrentEpoch()) return;

  const hasTargetRegistration = registrationHasTargetEpoch(registration);
  if (!epochReset && !hasTargetRegistration) return;

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

  const maybeReloadFromRegistration = (reason: string) => {
    if (!registrationHasTargetEpoch(registration)) return;
    if (getServiceWorkerEpoch(navigator.serviceWorker.controller) === MAP_CACHE_EPOCH) {
      reloadOnce(`${reason}: controller updated`);
      return;
    }
    const activeEpoch = getServiceWorkerEpoch(registration?.active);
    if (activeEpoch === MAP_CACHE_EPOCH) {
      reloadOnce(`${reason}: target registration active without takeover`);
    }
  };

  const trackedWorker = registration?.installing ?? registration?.waiting ?? null;

  const onControllerChange = () => {
    if (getServiceWorkerEpoch(navigator.serviceWorker.controller) !== MAP_CACHE_EPOCH) return;
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    trackedWorker?.removeEventListener('statechange', onTrackedWorkerStateChange);
    clearTimeout(fallbackTimer);
    reloadOnce('controllerchange');
  };

  const onTrackedWorkerStateChange = () => {
    maybeReloadFromRegistration(`registration state=${trackedWorker?.state ?? 'unknown'}`);
  };

  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  trackedWorker?.addEventListener('statechange', onTrackedWorkerStateChange);
  const fallbackTimer = window.setTimeout(() => {
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    trackedWorker?.removeEventListener('statechange', onTrackedWorkerStateChange);
    if (registrationHasTargetEpoch(registration)) {
      reloadOnce('takeover timeout with target registration present');
      return;
    }
    if (epochReset) {
      reloadOnce('takeover timeout after epoch reset');
    }
  }, 2500);

  maybeReloadFromRegistration('post-register');
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

// Module-scoped handle to the live registration so the late-recovery path can
// re-run `update()` on it. Assigned inside `swReady`.
let swRegistration: ServiceWorkerRegistration | null = null;

// True once any installing worker we registered has reached `redundant`
// WITHOUT ever giving us a controller. That state is the page-visible
// signature of an install failure — most commonly an `importScripts()`
// throw inside sw-dem.js when one of its ~28 submodule fetches hiccupped
// during a deploy / on a flaky network. The worker never activates, so
// `clients.claim()` never runs and no `controllerchange` ever fires.
let swInstallFailed = false;

function watchForRedundantInstall(registration: ServiceWorkerRegistration): void {
  const tracked = registration.installing ?? registration.waiting ?? null;
  if (!tracked) return;
  const onState = () => {
    if (tracked.state === 'redundant' && !navigator.serviceWorker.controller) {
      swInstallFailed = true;
    }
    if (tracked.state === 'redundant' || tracked.state === 'activated') {
      tracked.removeEventListener('statechange', onState);
    }
  };
  tracked.addEventListener('statechange', onState);
}

/**
 * Self-heal a registration whose worker failed to take control. Re-runs
 * `update()` (which re-fetches sw-dem.js AND every epoch-busted submodule,
 * recovering a transient `importScripts()` failure) and then waits for the
 * controller to appear, for up to a few bounded attempts.
 *
 * Returns `true` as soon as a controller is present, `false` if every
 * attempt is exhausted without one.
 */
async function recoverServiceWorkerRegistration(maxAttempts: number): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (navigator.serviceWorker.controller) return true;

    let registration = swRegistration;
    try {
      // Re-register defensively with a one-shot recovery nonce. A plain
      // re-register/update() with the IDENTICAL script URL is frequently a
      // no-op: the browser only re-runs install→activate when the fetched
      // script bytes differ. Appending `rv-sw-recovery=<attempt-ts>` makes
      // the browser see a "new" worker and forces a fresh install cycle,
      // which re-fetches every epoch-busted submodule and recovers a
      // transient importScripts() failure. The SW only reads
      // `rv-map-cache-epoch`, so the extra param never affects cache keys.
      const recoveryUrl =
        `/sw-dem.js?rv-map-cache-epoch=${encodeURIComponent(MAP_CACHE_EPOCH)}`
        + `&rv-sw-recovery=${Date.now()}-${attempt}`;
      registration = await navigator.serviceWorker.register(recoveryUrl, { scope: '/' });
      swRegistration = registration;
      watchForRedundantInstall(registration);
      swInstallFailed = false;
      await registration.update();
    } catch (err) {
      console.warn(`[sw-dem] recovery attempt ${attempt}/${maxAttempts} — register/update failed:`, err);
    }

    // Wait for the controller to appear after this attempt. Give later
    // attempts a longer window — a cold install on a slow link can take
    // several seconds to fetch all submodules and activate.
    const waitMs = Math.min(4000 + attempt * 2000, 10_000);
    const controller = await waitForServiceWorkerController(waitMs);
    if (controller) {
      console.log(`[sw-dem] recovery succeeded on attempt ${attempt} — controller claimed`);
      return true;
    }
  }

  return false;
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
    swRegistration = registration;
    watchForRedundantInstall(registration);

    if (epochReset) {
      notifyRegistrationMapCacheReset(registration);
      notifyMapCacheReset(navigator.serviceWorker.controller);
    }

    scheduleEpochTakeoverReload(registration, epochReset);

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
    // If the installing worker went redundant, the SW will NEVER claim on
    // its own (importScripts/install threw). Stop polling a dead worker and
    // self-heal immediately via re-register + update().
    if (swInstallFailed) {
      console.warn('[sw-dem] install failed (worker redundant) — attempting registration self-heal');
      const recovered = await recoverServiceWorkerRegistration(3);
      if (recovered) return true;
      break;
    }
    interval = Math.min(interval * 1.5, 2000);
  }

  // Last-ditch self-heal even when we never observed an explicit redundant
  // transition (e.g. the statechange fired before our listener attached, or
  // the activate phase stalled). A fresh update() is cheap and is the single
  // most effective recovery for a transient submodule fetch failure.
  if (!navigator.serviceWorker.controller) {
    const recovered = await recoverServiceWorkerRegistration(2);
    if (recovered) return true;
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