import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LidarRouteOverlayItem, LidarRouteSyncMessage } from './routeOverlaySync';

/**
 * Plusieurs onglets de l'app (un projet chacun) et un visualiseur LiDAR
 * ouvert depuis l'un d'eux, sur le vrai BroadcastChannel de Node (un graphe
 * de modules par onglet) : chaque message porte son projet et n'est traité
 * que par l'onglet de ce projet (C2-1).
 */

type RouteSync = typeof import('./routeOverlaySync');

const store = new Map<string, string>();
const unsubscribers: Array<() => void> = [];

beforeEach(() => {
  store.clear();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
});

afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  vi.unstubAllGlobals();
});

/** Un onglet : son propre module, son projet. */
async function tab(projectId: string | null): Promise<RouteSync> {
  vi.resetModules();
  const sync = await import('./routeOverlaySync');
  sync.setLidarRouteSyncProject(projectId);
  return sync;
}

function listen(sync: RouteSync): LidarRouteSyncMessage[] {
  const received: LidarRouteSyncMessage[] = [];
  unsubscribers.push(sync.subscribeToLidarRouteOverlay((message) => received.push(message)));
  return received;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const route: LidarRouteOverlayItem = {
  id: 'lidar-1', name: 'Tracé du visualiseur', color: '#E53935', opacity: 1, visible: true,
  points: [{ lat: 45, lon: 6 }, { lat: 45.01, lon: 6.01 }],
};

describe('visualiseur LiDAR et onglets de plusieurs projets', () => {
  it('une trace créée ou copiée dans le visualiseur ne va qu’au projet d’où il a été ouvert (C2-1)', async () => {
    const alpes = await tab('alpes');
    const pyrenees = await tab('pyrenees');
    const viewer = await tab('alpes');
    const toAlpes = listen(alpes);
    const toPyrenees = listen(pyrenees);

    viewer.broadcastLidarRouteCreate(route, 'lidar_viewer');
    viewer.broadcastLidarRouteDuplicate('it-1', { ...route, id: 'lidar-2' }, 'lidar_viewer');
    await settle();

    expect(toAlpes.map((message) => ('type' in message ? message.type : 'STATE'))).toEqual(['CREATE_ROUTE', 'DUPLICATE_ROUTE']);
    expect(toPyrenees).toEqual([]);
  });

  it('deux onglets sur le même projet : un seul applique les traces du visualiseur, l’autre prend le relais (C2-1)', async () => {
    const first = await tab('alpes');
    const second = await tab('alpes');
    const releaseFirst = first.claimLidarRouteTaker('alpes');
    const releaseSecond = second.claimLidarRouteTaker('alpes');
    await settle();
    expect([first.isLidarRouteTaker(), second.isLidarRouteTaker()]).toEqual([true, false]);

    // Premier onglet fermé (projet quitté) : le second applique désormais.
    releaseFirst();
    await settle();
    expect([first.isLidarRouteTaker(), second.isLidarRouteTaker()]).toEqual([false, true]);
    releaseSecond();
  });

  it('projet quitté quand le verrou est accordé mais son rappel pas encore lancé : rendu tout de suite (C2-1, relecture)', async () => {
    // Verrou déjà accordé (l'abandon n'y peut plus rien), rappel lancé un peu plus tard.
    let held = false;
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, _options: unknown, callback: () => unknown) => new Promise<void>((resolve) => {
          setTimeout(() => {
            held = true;
            // Comme les Web Locks : verrou rendu quand le résultat du rappel (promesse ou non) est réglé.
            void Promise.resolve(callback()).then(() => {
              held = false;
              resolve();
            });
          }, 10);
        }),
      },
    });
    const sync = await tab('alpes');
    sync.claimLidarRouteTaker('alpes')();
    await settle();
    expect(sync.isLidarRouteTaker()).toBe(false);
    expect(held).toBe(false);
  });

  it('le visualiseur n’affiche que les traces de son projet ; l’URL l’ouvre sur le projet de l’onglet', async () => {
    const pyrenees = await tab('pyrenees');
    const viewer = await tab('alpes');
    const shown = listen(viewer);

    pyrenees.syncLidarRouteOverlay([], 'redview_app');
    await settle();
    expect(shown).toEqual([]);
    // Copie localStorage écrite après 100 ms, sous la clé de son projet : jamais lue par le visualiseur des Alpes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(viewer.loadLidarRouteOverlay()?.projectId).not.toBe('pyrenees');
    expect(store.has('redview:lidar:route_overlay:pyrenees')).toBe(true);

    const { buildViewerUrl } = await import('./viewerUrl');
    const url = new URL(buildViewerUrl({ xKm: 965, yKm: 6500, projection: 'EPSG:2154', altRef: 'NGF-IGN69' } as never, null, 'alpes'), 'https://app.test');
    expect(url.searchParams.get('project')).toBe('alpes');
  });
});
