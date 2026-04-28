import { MAPBOX_TOKEN } from '../../lib/mapbox.config';
import {
  SW_CONTROLLER_TIMEOUT,
  TOKEN_ACK_MAX_ATTEMPTS,
  TOKEN_ACK_TIMEOUT,
} from './constants';

async function sendTokenWithAck(controller: ServiceWorker): Promise<boolean> {
  for (let attempt = 1; attempt <= TOKEN_ACK_MAX_ATTEMPTS; attempt++) {
    const ack = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        resolve(false);
      }, TOKEN_ACK_TIMEOUT);
      const onMsg = (event: MessageEvent) => {
        if (event.data?.type === 'TOKEN_ACK') {
          clearTimeout(timer);
          navigator.serviceWorker.removeEventListener('message', onMsg);
          resolve(true);
        }
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
    });

    controller.postMessage({ type: 'SET_MAPBOX_TOKEN', token: MAPBOX_TOKEN });
    const ok = await ack;
    if (ok) return true;
    console.warn(`[sw-dem] TOKEN_ACK missed (attempt ${attempt}/${TOKEN_ACK_MAX_ATTEMPTS})`);
  }
  return false;
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

export const swReady: Promise<boolean> = (async () => {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('/sw-dem.js', { scope: '/' });

    const controller = await waitForServiceWorkerController(SW_CONTROLLER_TIMEOUT);
    if (!controller) {
      console.warn('[sw-dem] No controller after registration timeout - proceeding without IGN enhancement');
      return false;
    }

    const acked = await sendTokenWithAck(controller);
    if (!acked) {
      console.error('[sw-dem] Token ACK failed - proceeding without IGN enhancement');
      return false;
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const nextController = navigator.serviceWorker.controller;
      if (nextController) sendTokenWithAck(nextController).catch(() => {});
    });

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type === 'REQUEST_TOKEN') {
        const nextController = navigator.serviceWorker.controller;
        if (nextController) sendTokenWithAck(nextController).catch(() => {});
      }
    });

    return true;
  } catch (error) {
    console.error('[sw-dem] Registration failed:', error);
    return false;
  }
})();