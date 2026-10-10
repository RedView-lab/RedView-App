import { describe, expect, it, vi } from 'vitest';

import { MAP_CACHE_EPOCH } from './mapCacheEpoch';
import {
  getServiceWorkerEpoch,
  isServiceWorkerControllerCurrent,
  subscribeServiceWorkerController,
} from './serviceWorkerController';

function worker(epoch: string): ServiceWorker {
  return { scriptURL: `https://redview.tech/sw-dem.js?rv-map-cache-epoch=${encodeURIComponent(epoch)}` } as ServiceWorker;
}

function stubContainer(controller: ServiceWorker | null) {
  const listeners = new Set<() => void>();
  const container = {
    controller,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('navigator', { serviceWorker: container });
  return { container, listeners };
}

describe('Service Worker de ce build', () => {
  it("lit l'époque dans l'URL du script, paramètre de récupération compris", () => {
    expect(getServiceWorkerEpoch(worker('abc:2026'))).toBe('abc:2026');
    expect(getServiceWorkerEpoch({ scriptURL: 'https://redview.tech/sw-dem.js?rv-map-cache-epoch=x&rv-sw-recovery=1-2' } as ServiceWorker)).toBe('x');
    expect(getServiceWorkerEpoch(null)).toBeNull();
  });

  it("ne reconnaît que le worker de l'époque courante", () => {
    stubContainer(worker(MAP_CACHE_EPOCH));
    expect(isServiceWorkerControllerCurrent()).toBe(true);

    stubContainer(worker('3ba3fad2:2026-10-02-gesture-cancel-1'));
    expect(isServiceWorkerControllerCurrent()).toBe(false);

    stubContainer(null);
    expect(isServiceWorkerControllerCurrent()).toBe(false);

    vi.stubGlobal('navigator', {});
    expect(isServiceWorkerControllerCurrent()).toBe(false);
  });

  it('suit controllerchange et se désabonne', () => {
    const { container, listeners } = stubContainer(worker('ancien'));
    let calls = 0;
    const unsubscribe = subscribeServiceWorkerController(() => {
      calls += 1;
    });
    expect(isServiceWorkerControllerCurrent()).toBe(false);

    container.controller = worker(MAP_CACHE_EPOCH);
    for (const listener of listeners) listener();
    expect(calls).toBe(1);
    expect(isServiceWorkerControllerCurrent()).toBe(true);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});
