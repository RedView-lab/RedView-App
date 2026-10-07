// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import { createDefaultItinerary } from '../../lib/project/defaultState';
import type { Itinerary } from '../../types';
import { useItineraryBrouterRouting } from './index';
import { resolveRouteRequest } from './resolveRouteRequest';

/**
 * Route loading of the routing hook, as the app sees it: the `routeLoading`
 * value of each committed render (panel spinner, overlay status) and the
 * `rv-route-loading` window events (map cursor loader), through every way a
 * routing run starts, ends, is replaced or cancelled. BRouter is simulated by
 * promises the test settles.
 */

vi.mock('./resolveRouteRequest', () => ({ resolveRouteRequest: vi.fn() }));
vi.mock('./elasticRoutePatch', () => ({
  resolveElasticRoutePatch: (
    patch: unknown,
    _stored: unknown,
    _signal: AbortSignal,
    routePatch: (patch: unknown) => Promise<object>,
  ) => routePatch(patch).then((resolved) => ({ ...resolved, patch })),
}));
vi.mock('./routingAnalytics', () => ({ trackRouteComputed: () => {}, trackRouteFailed: () => {} }));
vi.mock('../../lib/route-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/route-metrics')>()),
  refineRouteProfileWithIgnAltimetry: async () => null,
}));

interface PendingRequest {
  itineraryId: string;
  start: { lat: number; lon: number };
  signal: AbortSignal;
  resolve: (from?: { lat: number; lon: number }) => void;
  reject: (error: Error) => void;
}

let requests: PendingRequest[] = [];
let mounted: Array<() => void> = [];
let events: boolean[] = [];
const onLoadingEvent = (event: Event) => events.push((event as CustomEvent<{ loading: boolean }>).detail.loading);

beforeEach(() => {
  requests = [];
  events = [];
  window.addEventListener('rv-route-loading', onLoadingEvent);
  vi.mocked(resolveRouteRequest).mockImplementation(({ itinerary, requestBase, signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      requests.push({
        itineraryId: itinerary.id,
        start: requestBase.start,
        signal,
        resolve: (from = requestBase.start) => resolve({
          route: {
            coordinates: [[from.lon, from.lat], [requestBase.end.lon, requestBase.end.lat]],
            distanceM: 1000,
            ascentM: 10,
          },
          resolvedWarnings: [],
          resolved: { profileId: 'road', brf: '', roadTypes: { warnings: [] } },
        } as unknown as Awaited<ReturnType<typeof resolveRouteRequest>>),
        reject,
      });
    }));
});

afterEach(() => {
  for (const unmount of mounted) unmount();
  mounted = [];
  window.removeEventListener('rv-route-loading', onLoadingEvent);
});

const A = { lat: 45.1, lon: 5.7 };
const B = { lat: 45.2, lon: 5.8 };
const C = { lat: 45.3, lon: 5.9 };

function storedPoints(from = A, to = B) {
  return [
    { lat: from.lat, lon: from.lon, elevationM: null, distanceM: 0 },
    { lat: to.lat, lon: to.lon, elevationM: null, distanceM: 13_000 },
  ];
}

function itinerary(id: string, overrides: Partial<Itinerary> = {}): Itinerary {
  const base = createDefaultItinerary();
  return {
    ...base,
    id,
    timeline: [
      { ...base.timeline[0]!, ...A },
      { ...base.timeline[1]!, ...B },
    ],
    ...overrides,
  };
}

/** Imported GPX: the stored route is authoritative, nothing to route. */
function gpxItinerary(id: string, overrides: Partial<Itinerary> = {}): Itinerary {
  return itinerary(id, { gpxRoute: { name: id, source: 'gpx', points: storedPoints() }, ...overrides });
}

const patch = (): NonNullable<Itinerary['pendingRoutePatch']> => ({
  start: { ...A, kind: 'start' },
  via: [C],
  end: { ...B, kind: 'end' },
});

interface Props {
  active: Itinerary | null;
  itineraries: Itinerary[];
}

function renderRouting(initial: Props) {
  const states: boolean[] = [];
  const setProject = vi.fn();
  const rollbackPendingTraceAppend = vi.fn(() => false);
  // Stable like the app's: a new object per render would re-run the routing effect.
  const map = {} as MapboxMap;
  const rendered = renderHook(
    ({ active, itineraries }: Props) => {
      const routing = useItineraryBrouterRouting({
        active,
        itineraries,
        historyRevision: 0,
        isMapLoaded: true,
        map,
        rollbackPendingTraceAppend,
        setProject,
      });
      // Committed values only (a render React restarts is not seen).
      useEffect(() => {
        states.push(routing.routeLoading);
      }, [routing.routeLoading]);
      return routing;
    },
    { initialProps: initial },
  );
  let isMounted = true;
  const unmount = () => {
    if (!isMounted) return;
    isMounted = false;
    rendered.unmount();
  };
  mounted.push(unmount);
  return { ...rendered, unmount, states, setProject };
}

/** Lets microtasks, promise chains and React updates settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** Past the 120 ms debounce of a full recompute. */
async function afterDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  await settle();
}

describe('useItineraryBrouterRouting — route loading', () => {
  it('full recompute: loading from the scheduling, off when the route arrives', async () => {
    const active = itinerary('a');
    const { states, result } = renderRouting({ active, itineraries: [active] });
    await settle();
    expect(states).toEqual([false, true]);
    expect(events).toEqual([true]);
    expect(requests).toHaveLength(0);

    await afterDebounce();
    expect(requests).toHaveLength(1);
    expect(events).toEqual([true, true]);
    expect(result.current.routeRequestNonce).toBe(1);

    requests[0]!.resolve();
    await settle();
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, true, false, false]);
    expect(result.current.routeError).toBeNull();
  });

  it('full recompute failure: loading off, error shown', async () => {
    const active = itinerary('a');
    const { states, result } = renderRouting({ active, itineraries: [active] });
    await afterDebounce();
    requests[0]!.reject(new Error('BRouter down'));
    await settle();
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, true, false]);
    expect(result.current.routeError).not.toBeNull();
  });

  it('inputs changed during the debounce: one request, loading stays on', async () => {
    const active = itinerary('a');
    const { states, rerender } = renderRouting({ active, itineraries: [active] });
    await settle();
    const moved = itinerary('a', { timeline: [{ ...active.timeline[0]!, ...A }, { ...active.timeline[1]!, ...C }] });
    rerender({ active: moved, itineraries: [moved] });
    await settle();
    expect(states).toEqual([false, true]);
    expect(events).toEqual([true, true]);
    await afterDebounce();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
  });

  it('route no longer routable mid-request: request aborted, loading off', async () => {
    const active = itinerary('a');
    const { states, rerender, setProject } = renderRouting({ active, itineraries: [active] });
    await afterDebounce();
    const noEnd = itinerary('a', { timeline: [{ ...active.timeline[0]!, ...A }, { ...active.timeline[1]!, lat: undefined, lon: undefined }] });
    rerender({ active: noEnd, itineraries: [noEnd] });
    await settle();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, true, false]);
    expect(setProject).toHaveBeenCalledTimes(1);
  });

  it('imported GPX (nothing to route): never loading, one settling event', async () => {
    const active = gpxItinerary('a');
    const { states } = renderRouting({ active, itineraries: [active] });
    await afterDebounce();
    expect(requests).toHaveLength(0);
    expect(states).toEqual([false]);
    expect(events).toEqual([false]);
  });

  it('local patch on the active itinerary: loading until the patch is applied', async () => {
    const active = gpxItinerary('a', { pendingRoutePatch: patch() });
    const { states, setProject, result } = renderRouting({ active, itineraries: [active] });
    await settle();
    expect(requests.map((r) => r.itineraryId)).toEqual(['a']);
    expect(states).toEqual([false, true]);
    expect(events).toEqual([true]);
    expect(result.current.routeRequestNonce).toBe(1);

    requests[0]!.resolve();
    await settle();
    expect(setProject).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, false]);
  });

  it('same patch still in flight when the effect re-runs: not restarted, loading kept', async () => {
    const active = gpxItinerary('a', { pendingRoutePatch: patch() });
    const { states, rerender } = renderRouting({ active, itineraries: [active] });
    await settle();
    // The stored route changed (point count, a dependency of the effect) but
    // not the patch nor the routing inputs: the running job is kept.
    const points = [...storedPoints(), { lat: C.lat, lon: C.lon, elevationM: null, distanceM: 26_000 }];
    const same = { ...active, gpxRoute: { name: 'a', source: 'gpx' as const, points } };
    rerender({ active: same, itineraries: [same] });
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    expect(states).toEqual([false, true]);
    expect(events).toEqual([true, true]);
  });

  it('cancel during a local patch: aborted, loading off, nothing applied', async () => {
    const active = gpxItinerary('a', { pendingRoutePatch: patch() });
    const { states, result, setProject } = renderRouting({ active, itineraries: [active] });
    await settle();
    act(() => result.current.cancelRouteRequest());
    await settle();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(setProject).not.toHaveBeenCalled();
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, false]);
  });

  it('local patch on another itinerary: routed in the background, loading untouched', async () => {
    const active = gpxItinerary('a');
    const other = gpxItinerary('b', { pendingRoutePatch: patch() });
    const { states, setProject } = renderRouting({ active, itineraries: [active, other] });
    await settle();
    expect(requests.map((r) => r.itineraryId)).toEqual(['b']);
    expect(states).toEqual([false]);
    expect(events).toEqual([false]);

    requests[0]!.resolve();
    await settle();
    expect(setProject).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false]);
    expect(events).toEqual([false]);
  });

  it('selection changed while a patch is in flight: the job continues, loading follows the new selection', async () => {
    const a = gpxItinerary('a', { pendingRoutePatch: patch() });
    const b = gpxItinerary('b');
    const { states, rerender, setProject } = renderRouting({ active: a, itineraries: [a, b] });
    await settle();
    rerender({ active: b, itineraries: [a, b] });
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, false]);

    requests[0]!.resolve();
    await settle();
    expect(setProject).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, false]);
  });

  it('tracer click (append): loading until the extension is applied', async () => {
    const active = itinerary('a', {
      gpxRoute: { name: 'a', source: 'brouter', points: storedPoints() },
      pendingTraceExtension: { from: B, to: C },
    });
    const { states, setProject } = renderRouting({ active, itineraries: [active] });
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.start).toEqual(B);
    expect(states).toEqual([false, true]);
    expect(events).toEqual([true]);

    requests[0]!.resolve(B);
    await settle();
    expect(setProject).toHaveBeenCalledTimes(1);
    expect(states).toEqual([false, true, false]);
    expect(events).toEqual([true, false, false]);
  });

  it('unmount while loading: a final « not loading » event for the map cursor', async () => {
    const active = itinerary('a');
    const { unmount } = renderRouting({ active, itineraries: [active] });
    await afterDebounce();
    expect(events).toEqual([true, true]);
    unmount();
    await settle();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(events).toEqual([true, true, false]);
  });
});
