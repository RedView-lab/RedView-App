// @vitest-environment happy-dom
import { act } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import type { GpxRoute, PoiCategory, PoiFeature } from '../types';

/**
 * État de la recherche en corridor : il appartient à l'itinéraire qui l'a
 * lancée. Changer d'itinéraire le rend inactif dès ce rendu, et la recherche
 * abandonnée ne touche plus celui du nouvel itinéraire.
 */

interface PendingSearch {
  onProgress: (deduped: PoiFeature[], progress: { done: number; total: number }) => void;
  resolve: (features: PoiFeature[]) => void;
  reject: (error: unknown) => void;
}

const searches = vi.hoisted(() => [] as PendingSearch[]);

vi.mock('../lib/poi-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/poi-api')>()),
  fetchPoisAlongRouteChunked: (options: { onProgress: PendingSearch['onProgress'] }) =>
    new Promise<PoiFeature[]>((resolve, reject) => {
      searches.push({ onProgress: options.onProgress, resolve, reject });
      options.onProgress([], { done: 0, total: 2 });
    }),
}));

vi.mock('../lib/poi-markers', () => ({
  PoiMarkerManager: class {
    sync() {}
    destroy() {}
    openPoi() {
      return false;
    }
  },
}));

const { usePoi } = await import('./usePoi');

const CATEGORIES = new Set<PoiCategory>(['drinking_water']);
const ROUTE: GpxRoute = {
  name: null,
  points: [
    { lat: 45, lon: 6 },
    { lat: 45.01, lon: 6.01 },
  ],
} as GpxRoute;
const MAP = {} as MapboxMap;

function renderPoi(routeId: string) {
  return renderHook(
    (id: string) => usePoi(MAP, true, CATEGORIES, ROUTE, 1000, null, undefined, undefined, null, {}, id),
    { initialProps: routeId },
  );
}

beforeEach(() => {
  searches.length = 0;
});

describe('usePoi : recherche en corridor', () => {
  it('suit la progression puis l\'échec de la recherche de son itinéraire', async () => {
    const hook = renderPoi('a');
    act(() => hook.result.current.searchCorridor());
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.corridorProgress).toBe(0);

    act(() => searches[0].onProgress([], { done: 1, total: 2 }));
    expect(hook.result.current.corridorProgress).toBe(0.5);

    await act(async () => searches[0].reject(new Error('réseau')));
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.corridorProgress).toBeNull();
    expect(hook.result.current.error).not.toBeNull();
  });

  it('redevient inactive au rendu même du changement d\'itinéraire, sans reprise par l\'ancienne recherche', async () => {
    const hook = renderPoi('a');
    act(() => hook.result.current.searchCorridor());
    expect(hook.result.current.loading).toBe(true);

    hook.rerender('b');
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.corridorProgress).toBeNull();
    expect(hook.result.current.error).toBeNull();

    // L'ancienne recherche répond encore : rien ne change pour « b ».
    act(() => searches[0].onProgress([], { done: 1, total: 2 }));
    await act(async () => searches[0].reject(new Error('réseau')));
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.corridorProgress).toBeNull();
    expect(hook.result.current.error).toBeNull();

    // Une recherche lancée sur « b » suit son propre cours.
    act(() => hook.result.current.searchCorridor());
    expect(hook.result.current.loading).toBe(true);
    await act(async () => searches[1].resolve([]));
    expect(hook.result.current.loading).toBe(false);
  });

  it('l\'annulation remet la recherche au repos', () => {
    const hook = renderPoi('a');
    act(() => hook.result.current.searchCorridor());
    act(() => hook.result.current.cancelSearchCorridor());
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.corridorProgress).toBeNull();
    expect(hook.result.current.error).toBeNull();
  });
});
