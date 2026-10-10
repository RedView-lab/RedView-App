// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import { createDefaultItinerary, createDefaultProject } from '../../lib/project';
import type { Itinerary, ItineraryProject } from '../../types';

/**
 * Import GPX : ce qui arrive en arrière-plan après l'ajout de l'itinéraire
 * (revêtements BRouter, noms de lieux) ne défait jamais une modification faite
 * entre-temps — les points de l'import remplaçaient le tracé, les coordonnées
 * de l'import revenaient sur le départ / l'arrivée.
 */

const deferred = vi.hoisted(() => ({
  surfaces: null as null | ((value: unknown) => void),
  /** Noms de lieux en attente : libérés par le test (`releaseNames`). */
  names: [] as Array<() => void>,
}));

function releaseNames() {
  for (const release of deferred.names.splice(0)) release();
}

vi.mock('@/features/poi/lib/gpx-loader', () => ({
  parseGpxFile: vi.fn(async () => ({
    name: 'Boucle',
    // ~8,9 km plein nord (deux points de passage échantillonnés), un point tous les ~110 m.
    points: Array.from({ length: 81 }, (_, i) => ({ lat: 45 + i * 0.001, lon: 6, elevationM: 500 + i })),
  })),
}));
vi.mock('./importedGpxGaps', () => ({
  bridgeImportedGpxGaps: async (route: unknown) => ({ route, bridged: 0, unbridged: 0 }),
}));
vi.mock('../../lib/routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/routes')>()),
  refineImportedRoutePointsWithIgnAltimetry: async () => null,
}));
vi.mock('../../lib/route-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/route-metrics')>()),
  analyzeGpxSurfaces: vi.fn((points: Array<Record<string, unknown>>) => new Promise((resolve) => {
    deferred.surfaces = () => resolve({
      points: points.map((point) => ({ ...point, surface: 'gravel' })),
      metrics: { distanceM: 8900, tarmacPercent: 0, offroadPercent: 100 },
      surfaceBreakdownKm: { asphalt: 0, paved: 0, gravel: 8.9, dirt: 0, sand: 0, unknown: 0 },
    });
  })),
}));
vi.mock('./importedTimelineLabel', () => ({
  resolveImportedTimelineLabel: () => new Promise<string>((resolve) => deferred.names.push(() => resolve('Annecy'))),
}));
vi.mock('../../lib/geocoding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/geocoding')>()),
  reverseGeocodeSettlement: () => new Promise((resolve) => deferred.names.push(() => resolve({ name: 'Village' }))),
}));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: vi.fn() }));
vi.mock('@/shared/lib/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));

const { useItineraryGpxImport } = await import('./useItineraryGpxImport');
const { simplifyPointsByQuality } = await import('../../lib/routes');

function setup() {
  let project: ItineraryProject = { ...createDefaultProject(), itineraries: [] };
  const setProject = (next: ItineraryProject | ((state: ItineraryProject) => ItineraryProject)) => {
    project = typeof next === 'function' ? next(project) : next;
  };
  const addItinerary = (overrides: Partial<Itinerary> = {}) => {
    const itinerary = { ...createDefaultItinerary(1), ...structuredClone(overrides) };
    project = { ...project, itineraries: [...project.itineraries, itinerary], activeItineraryId: itinerary.id };
    return itinerary.id;
  };
  const hook = renderHook(() => useItineraryGpxImport({
    setProject,
    addItinerary,
    setPendingCorridorFor: () => {},
  }), { initialProps: undefined });
  return {
    hook,
    project: () => project,
    itinerary: () => project.itineraries[0]!,
    edit: (change: (itinerary: Itinerary) => Itinerary) => setProject((state) => ({
      ...state,
      itineraries: state.itineraries.map((itinerary, index) => (index === 0 ? change(itinerary) : itinerary)),
    })),
  };
}

async function importGpx(state: ReturnType<typeof setup>) {
  await act(async () => {
    await state.hook.result.current.addItineraryFromGpxFile(new File(['<gpx/>'], 'boucle.gpx'));
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  deferred.surfaces = null;
  deferred.names.length = 0;
});

describe('useItineraryGpxImport : résultats en arrière-plan', () => {
  it('tracé inchangé : les revêtements sont reportés, avec la qualité de simplification courante', async () => {
    const state = setup();
    await importGpx(state);
    // Qualité changée pendant l'analyse.
    state.edit((itinerary) => ({ ...itinerary, gpxRoute: { ...itinerary.gpxRoute!, gpxQuality: 'expert', gpxQualityPointsPerKm: 2 } }));
    deferred.surfaces!(null);
    await flush();
    const route = state.itinerary().gpxRoute!;
    expect(route.originalPoints!.every((point) => point.surface === 'gravel')).toBe(true);
    expect(route.gpxQuality).toBe('expert');
    expect(route.points.length).toBe(simplifyPointsByQuality(route.originalPoints!, 'expert', 2).length);
    expect(route.points.length).toBeLessThan(route.originalPoints!.length);
    expect(state.itinerary().metrics?.offroadPercent).toBe(100);
  });

  it('tracé modifié pendant l’analyse : la modification reste, les revêtements de l’ancien tracé sont abandonnés', async () => {
    const state = setup();
    await importGpx(state);
    const cropped = state.itinerary().gpxRoute!.originalPoints!.slice(5);
    state.edit((itinerary) => ({ ...itinerary, gpxRoute: { ...itinerary.gpxRoute!, points: cropped, originalPoints: cropped } }));
    deferred.surfaces!(null);
    await flush();
    const route = state.itinerary().gpxRoute!;
    expect(route.originalPoints).toBe(cropped);
    expect(route.points).toBe(cropped);
  });

  it('noms de lieux : appliqués aux lignes intactes, jamais à un départ renommé ou une arrivée déplacée entre-temps', async () => {
    const state = setup();
    await importGpx(state);
    const waypointIds = state.itinerary().timeline.filter((item) => item.kind === 'waypoint').map((item) => item.id);
    expect(waypointIds.length).toBeGreaterThan(0);
    state.edit((itinerary) => ({
      ...itinerary,
      timeline: itinerary.timeline.map((item) => {
        if (item.kind === 'start') return { ...item, label: 'Chez moi' };
        if (item.kind === 'end') return { ...item, lat: 46, lon: 6.5 };
        return item;
      }),
    }));
    releaseNames(); // départ / arrivée
    await flush();
    releaseNames(); // points de passage
    await flush();
    const timeline = state.itinerary().timeline;
    expect(timeline.find((item) => item.kind === 'start')?.label).toBe('Chez moi');
    const end = timeline.find((item) => item.kind === 'end')!;
    expect(end.label).not.toBe('Annecy');
    expect([end.lat, end.lon]).toEqual([46, 6.5]);
    for (const id of waypointIds) expect(timeline.find((item) => item.id === id)?.label).toBe('Village');
  });

  it('noms de lieux : départ et arrivée intacts reçoivent leur nom', async () => {
    const state = setup();
    await importGpx(state);
    releaseNames();
    await flush();
    const timeline = state.itinerary().timeline;
    expect(timeline.find((item) => item.kind === 'start')?.label).toBe('Annecy');
    expect(timeline.find((item) => item.kind === 'end')?.label).toBe('Annecy');
  });
});
