// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { describe, it, expect } from 'vitest';

import { ProjectStoreContext } from '@/features/itineraryPanel/context/ProjectStore/context';
import type { ProjectStoreValue } from '@/features/itineraryPanel/context/ProjectStore/types';
import type { Itinerary } from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n';
import { renderHook } from '@/shared/test/renderHook';
import { ForbiddenZoneToolProvider, useForbiddenZoneToolOptional } from './forbiddenZones/ForbiddenZoneToolContext';
import { RouteSplitToolProvider } from './routeSplit/RouteSplitToolContext';
import { useRouteSplitToolOptional } from './routeSplit/useRouteSplitTool';
import { TraceToolProvider } from './tracer/TraceToolContext';
import { useTraceToolOptional } from './tracer/useTraceTool';

/**
 * The map tools disarm when their target disappears and stay disarmed when it
 * comes back; arming again starts from a clean state. These used to be effects
 * setting state after the commit, now adjustments during render.
 */

type ItineraryShape = Partial<Itinerary> & { id: string };

/** Fake store: only what the providers read at render (no map, no edit). */
function fakeStore(itineraries: ItineraryShape[], activeItineraryId: string | null): ProjectStoreValue {
  return { project: { itineraries, activeItineraryId } } as unknown as ProjectStoreValue;
}

function route(pointCount: number): Itinerary['gpxRoute'] {
  return {
    name: 'r',
    source: 'gpx',
    points: Array.from({ length: pointCount }, (_, i) => ({ lat: 45, lon: 6 + i / 1000, elevationM: null, distanceM: i * 10 })),
  } as Itinerary['gpxRoute'];
}

type Props = { store: ProjectStoreValue };

function withProviders(Provider: (props: { children: ReactNode; map: null }) => ReactNode) {
  return function Wrapper({ children, props }: { children: ReactNode; props: Props }) {
    return (
      <ProjectStoreContext.Provider value={props.store}>
        <Provider map={null}>{children}</Provider>
      </ProjectStoreContext.Provider>
    );
  };
}

describe('Découper (RouteSplitToolProvider)', () => {
  const store = (points: number) => fakeStore([{ id: 'a', gpxRoute: route(points) }], 'a');

  it('disarms when the route can no longer be split, and stays disarmed when it can again', () => {
    const { result, rerender } = renderHook(() => useRouteSplitToolOptional()!, {
      initialProps: { store: store(10) },
      wrapper: withProviders(RouteSplitToolProvider),
    });
    expect(result.current.canSplit).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    expect(result.current.statusMessage).toBe(translateAppText('Cliquez sur la trace pour la découper'));

    rerender({ store: store(3) });
    expect(result.current.canSplit).toBe(false);
    expect(result.current.armed).toBe(false);

    rerender({ store: store(10) });
    expect(result.current.canSplit).toBe(true);
    expect(result.current.armed).toBe(false);
  });

  it('does not touch a disarmed tool on unrelated re-renders', () => {
    const { result, rerender } = renderHook(() => useRouteSplitToolOptional()!, {
      initialProps: { store: store(10) },
      wrapper: withProviders(RouteSplitToolProvider),
      strict: true,
    });
    act(() => result.current.toggle());
    rerender({ store: store(12) });
    expect(result.current.armed).toBe(true);
  });
});

describe('Tracer (TraceToolProvider)', () => {
  const row = (kind: 'start' | 'end', placed: boolean) => ({
    id: kind,
    kind,
    label: kind,
    lat: placed ? 45 : null,
    lon: placed ? 6 : null,
  });
  const store = (rows: ReturnType<typeof row>[]) => fakeStore([{ id: 'a', timeline: rows } as ItineraryShape], 'a');
  const promptStart = () => translateAppText('Cliquez sur la carte pour placer le départ');
  const promptEnd = () => translateAppText('Cliquez sur la carte pour placer l’arrivée');
  const promptExtend = () => translateAppText('Cliquez pour prolonger le tracé, glissez un point pour le déplacer');

  function renderTrace(rows: ReturnType<typeof row>[]) {
    return renderHook(() => useTraceToolOptional()!, {
      initialProps: { store: store(rows) },
      wrapper: withProviders(TraceToolProvider),
    });
  }

  it('the prompt follows the start and end being placed while armed', () => {
    const { result, rerender } = renderTrace([row('start', false), row('end', false)]);
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    expect(result.current.statusMessage).toBe(promptStart());

    rerender({ store: store([row('start', true), row('end', false)]) });
    expect(result.current.statusMessage).toBe(promptEnd());

    rerender({ store: store([row('start', true), row('end', true)]) });
    expect(result.current.statusMessage).toBe(promptExtend());
  });

  it('leaves the message alone while disarmed', () => {
    const { result, rerender } = renderTrace([row('start', false), row('end', false)]);
    rerender({ store: store([row('start', true), row('end', false)]) });
    expect(result.current.armed).toBe(false);
    expect(result.current.statusMessage).toBeNull();
  });

  it('disarms when tracing becomes impossible and stays disarmed afterwards', () => {
    const { result, rerender } = renderTrace([row('start', true), row('end', true)]);
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);

    rerender({ store: store([row('start', true)]) });
    expect(result.current.canTrace).toBe(false);
    expect(result.current.armed).toBe(false);

    rerender({ store: store([row('start', true), row('end', true)]) });
    expect(result.current.canTrace).toBe(true);
    expect(result.current.armed).toBe(false);
  });

  it('a manual deactivate clears the message', () => {
    const { result } = renderTrace([row('start', true), row('end', true)]);
    act(() => result.current.toggle());
    act(() => result.current.deactivate());
    expect(result.current.armed).toBe(false);
    expect(result.current.statusMessage).toBeNull();
  });
});

describe('Zone interdite (ForbiddenZoneToolProvider)', () => {
  const withActive = (active: string | null) => fakeStore([{ id: 'a' }], active);
  const firstVertexPrompt = () => translateAppText('Zone interdite: cliquez sur la carte pour placer le premier sommet');

  function renderZone() {
    return renderHook(() => useForbiddenZoneToolOptional()!, {
      initialProps: { store: withActive('a') },
      wrapper: withProviders(ForbiddenZoneToolProvider),
    });
  }

  it('arming starts an empty draft (prompt for the first vertex, nothing to undo)', () => {
    const { result } = renderZone();
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    expect(result.current.statusMessage).toBe(firstVertexPrompt());
    expect(result.current.canUndoDraft).toBe(false);
    expect(result.current.canRedoDraft).toBe(false);
  });

  it('disarms and drops the draft when the active itinerary goes away', () => {
    const { result, rerender } = renderZone();
    act(() => result.current.toggle());
    rerender({ store: withActive(null) });
    expect(result.current.canEdit).toBe(false);
    expect(result.current.armed).toBe(false);
    expect(result.current.statusMessage).toBeNull();

    rerender({ store: withActive('a') });
    expect(result.current.armed).toBe(false);
  });

  it('arming again after such a reset starts a fresh draft session', () => {
    // The draft history mirrors read by the handlers must have been reset too:
    // left at index 0, arming would skip the new session (no prompt).
    const { result, rerender } = renderZone();
    act(() => result.current.toggle());
    rerender({ store: withActive(null) });
    rerender({ store: withActive('a') });
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    expect(result.current.statusMessage).toBe(firstVertexPrompt());
  });

  it('toggling off without a polygon disarms with no message', () => {
    const { result } = renderZone();
    act(() => result.current.toggle());
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(false);
    expect(result.current.statusMessage).toBeNull();
  });
});
