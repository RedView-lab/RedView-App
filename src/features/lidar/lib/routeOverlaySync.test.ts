import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Itinerary } from '@/features/itineraryPanel/types';

const posted: unknown[] = [];

class FakeBroadcastChannel {
  postMessage(message: unknown) { posted.push(message); }
  close() {}
}

function itinerary(id: string, points: Array<{ lat: number; lon: number }>, extra: Partial<Itinerary> = {}): Itinerary {
  return { id, name: id, color: '#ff0000', gpxRoute: { name: null, points }, ...extra } as Itinerary;
}

async function loadModule() {
  vi.resetModules();
  return import('./routeOverlaySync');
}

beforeEach(() => {
  posted.length = 0;
  const store = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  });
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});

describe('syncLidarRouteOverlay', () => {
  it('reuses the viewer copy of an unchanged route array', async () => {
    const { extractLidarRouteOverlayState } = await loadModule();
    const points = [{ lat: 45, lon: 6 }, { lat: 45.1, lon: 6.1 }];
    const a = extractLidarRouteOverlayState([itinerary('a', points)]);
    const b = extractLidarRouteOverlayState([itinerary('a', points, { name: 'renamed' })]);
    expect(b.routes[0]?.points).toBe(a.routes[0]?.points);
    expect(a.routes[0]?.points).toEqual([
      { lat: 45, lon: 6, elevationM: null, distanceM: undefined },
      { lat: 45.1, lon: 6.1, elevationM: null, distanceM: undefined },
    ]);
    const c = extractLidarRouteOverlayState([itinerary('a', [...points])]);
    expect(c.routes[0]?.points).not.toBe(a.routes[0]?.points);
  });

  it('skips publishing when no route changed (onlyIfChanged)', async () => {
    const { syncLidarRouteOverlay } = await loadModule();
    const points = [{ lat: 45, lon: 6 }];
    const other = [{ lat: 46, lon: 7 }];
    syncLidarRouteOverlay([itinerary('a', points), itinerary('b', other)], 'redview_app', { onlyIfChanged: true });
    expect(posted).toHaveLength(1);

    // New itinerary objects (timeline, POI, prediction edit), same routes: nothing sent.
    syncLidarRouteOverlay([itinerary('a', points, { timeline: [] } as Partial<Itinerary>), itinerary('b', other)], 'redview_app', { onlyIfChanged: true });
    expect(posted).toHaveLength(1);

    // Each displayed property, the points and the route list count as a change.
    syncLidarRouteOverlay([itinerary('a', points, { color: '#00ff00' }), itinerary('b', other)], 'redview_app', { onlyIfChanged: true });
    syncLidarRouteOverlay([itinerary('a', points, { color: '#00ff00', visible: false }), itinerary('b', other)], 'redview_app', { onlyIfChanged: true });
    syncLidarRouteOverlay([itinerary('a', [...points], { color: '#00ff00', visible: false }), itinerary('b', other)], 'redview_app', { onlyIfChanged: true });
    syncLidarRouteOverlay([itinerary('b', other)], 'redview_app', { onlyIfChanged: true });
    expect(posted).toHaveLength(5);
  });

  it('always publishes on an explicit call (viewer opening, stored route restored)', async () => {
    const { syncLidarRouteOverlay } = await loadModule();
    const itineraries = [itinerary('a', [{ lat: 45, lon: 6 }])];
    syncLidarRouteOverlay(itineraries, 'redview_app', { onlyIfChanged: true });
    syncLidarRouteOverlay(itineraries);
    syncLidarRouteOverlay(itineraries);
    expect(posted).toHaveLength(3);
    syncLidarRouteOverlay(itineraries, 'redview_app', { onlyIfChanged: true });
    expect(posted).toHaveLength(3);
  });
});
