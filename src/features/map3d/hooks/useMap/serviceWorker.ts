import {
  SW_CONTROLLER_TIMEOUT,
} from './constants';

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

export const swReady: Promise<boolean> = (async () => {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('/sw-dem.js', { scope: '/' });

    const controller = await waitForServiceWorkerController(SW_CONTROLLER_TIMEOUT);
    if (!controller) {
      console.warn('[sw-dem] No controller after registration timeout - proceeding without DEM enhancement');
      return false;
    }

    return true;
  } catch (error) {
    console.error('[sw-dem] Registration failed:', error);
    return false;
  }
})();