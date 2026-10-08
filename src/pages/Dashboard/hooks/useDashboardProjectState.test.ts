// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultItinerary, createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { ProjectCloudError } from '@/shared/services/projects/errors';
import type { ProjectRow } from '@/shared/services/projects/types';
import { renderHook, type RenderedHook } from '@/shared/test/renderHook';

/**
 * Projet ouvert dans le Dashboard : seule la dernière ouverture demandée
 * compte, les modifications du projet courant partent avant d'en ouvrir un
 * autre, une copie locale non synchronisée est renvoyée (jamais celle d'un
 * projet partagé), et seules les couches touchées sont enregistrées.
 */

const services = vi.hoisted(() => ({
  rows: new Map<string, { row: unknown; delayMs?: number; error?: unknown }>(),
  cache: new Map<string, { project: unknown; cachedAt: string }>(),
  shared: new Set<string>(),
  calls: [] as string[],
  save: vi.fn<(id: string, project: { name: string }, options?: unknown) => Promise<void>>(),
  saveLocally: vi.fn<(id: string, project: unknown) => Promise<void>>(),
  queueView: vi.fn<(id: string, view: unknown) => void>(),
  flushViews: vi.fn<(id?: string) => Promise<void>>(),
  notifyError: vi.fn<(message: string) => void>(),
}));

vi.mock('@/shared/services/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/services/projects')>()),
  async getProject(id: string) {
    services.calls.push(`get:${id}`);
    const entry = services.rows.get(id);
    if (entry?.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
    if (entry?.error) throw entry.error;
    return entry?.row ?? null;
  },
  saveProject: async (id: string, project: { name: string }, options?: unknown) => {
    services.calls.push(`save:${id}:${project.name}`);
    return services.save(id, project, options);
  },
  saveProjectLocally: services.saveLocally,
  isServerOwnedDocument: (id: string) => services.shared.has(id),
  isSharedProject: (id: string) => services.shared.has(id),
  queueProjectViewSave: services.queueView,
  flushProjectViews: services.flushViews,
  uploadProjectThumbnail: async () => {},
}));
vi.mock('../lib/dashboardProjectCache', () => ({
  readFullProjectCacheAsync: async (id: string) => services.cache.get(id) ?? null,
}));
vi.mock('@/shared/lib/notify', () => ({ notify: { error: services.notifyError, success: vi.fn(), info: vi.fn() } }));
vi.mock('@/shared/lib/projectLocation', () => ({ replaceProjectLocation: () => {} }));
vi.mock('@/shared/lib/mapThumbnail', () => ({ captureMapThumbnail: async () => null }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const { useDashboardProjectState } = await import('./useDashboardProjectState');

type State = ReturnType<typeof useDashboardProjectState>;
let hook: RenderedHook<null, State> | null = null;

function mount(): () => State {
  hook = renderHook(() => useDashboardProjectState({ mapInstanceRef: { current: null } }), { initialProps: null });
  const rendered = hook;
  return () => rendered.result.current;
}

function project(name: string): ItineraryProject {
  const itinerary = createDefaultItinerary(1);
  return { ...createDefaultProject(), name, itineraries: [itinerary], activeItineraryId: itinerary.id };
}

function row(id: string, data: ItineraryProject, extra: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id, user_id: 'moi', folder_id: null, name: data.name, data, size_bytes: 0, privacy: 'private',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', dirty: false, cloud_updated_at: null, team_id: null,
    ...extra,
  };
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  services.rows.clear();
  services.cache.clear();
  services.shared.clear();
  services.calls = [];
  services.save.mockReset().mockResolvedValue(undefined);
  services.saveLocally.mockReset().mockResolvedValue(undefined);
  services.queueView.mockReset();
  services.flushViews.mockReset().mockResolvedValue(undefined);
  services.notifyError.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  hook?.unmount();
  hook = null;
  vi.useRealTimers();
});

describe('ouverture', () => {
  it('seule la dernière ouverture demandée compte, même si la précédente répond après', async () => {
    services.rows.set('lent', { row: row('lent', project('Lent')), delayMs: 500 });
    services.rows.set('rapide', { row: row('rapide', project('Rapide')) });
    const state = mount();
    await act(async () => {
      void state().openProject('lent');
      void state().openProject('rapide');
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(state().activeProjectId).toBe('rapide');
    expect(state().activeProjectInitial?.name).toBe('Rapide');
    expect(state().projectLoading).toBe(false);
  });

  it('une modification juste après l’ouverture est enregistrée sous le projet ouvert', async () => {
    services.rows.set('p1', { row: row('p1', project('Un')) });
    const state = mount();
    await act(async () => { await state().openProject('p1'); });
    act(() => state().handleProjectChange({ ...state().activeProjectInitial!, name: 'Un modifié' }));
    await advance(1_000);
    expect(services.calls).toContain('save:p1:Un modifié');
  });

  it('copie locale non synchronisée : renvoyée au cloud ; projet partagé : jamais', async () => {
    services.rows.set('p1', { row: row('p1', project('Local'), { dirty: true }) });
    services.rows.set('p2', { row: row('p2', project('Partagé'), { dirty: true, team_id: 'pp2' }) });
    const state = mount();
    await act(async () => { await state().openProject('p1'); });
    await advance(1_000);
    expect(services.calls).toContain('save:p1:Local');

    await act(async () => { await state().openProject('p2'); });
    await advance(2_000);
    expect(state().activeProjectShared).toBe(true);
    expect(services.calls.filter((call) => call.startsWith('save:p2'))).toEqual([]);
  });

  it('un instantané de reprise plus récent que la ligne est préféré, puis resynchronisé', async () => {
    services.rows.set('p1', { row: row('p1', project('Ligne')) });
    services.cache.set('p1', { project: project('Reprise'), cachedAt: '2026-10-01T00:00:06.000Z' });
    const state = mount();
    await act(async () => { await state().openProject('p1'); });
    expect(state().activeProjectInitial?.name).toBe('Reprise');
    await advance(1_000);
    expect(services.calls).toContain('save:p1:Reprise');
  });

  it('projet introuvable ou cloud injoignable : un message, rien n’est ouvert', async () => {
    const state = mount();
    await act(async () => { await state().openProject('absent'); });
    expect(services.notifyError).toHaveBeenLastCalledWith('Projet introuvable.');
    services.rows.set('p1', { row: null, error: new ProjectCloudError('offline') });
    await act(async () => { await state().openProject('p1'); });
    expect(services.notifyError).toHaveBeenLastCalledWith(expect.stringMatching(/^Connexion au cloud impossible/));
    expect(state().activeProjectId).toBeNull();
  });

  it('les modifications du projet courant partent avant l’ouverture d’un autre', async () => {
    services.rows.set('p1', { row: row('p1', project('Un')) });
    services.rows.set('p2', { row: row('p2', project('Deux')) });
    const state = mount();
    await act(async () => { await state().openProject('p1'); });
    act(() => state().handleProjectChange({ ...state().activeProjectInitial!, name: 'Un modifié' }));
    await act(async () => { await state().openProject('p2'); });
    expect(services.saveLocally).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'Un modifié' }));
    expect(services.calls.indexOf('save:p1:Un modifié')).toBeLessThan(services.calls.indexOf('get:p2'));
  });
});

describe('modifications du projet ouvert', () => {
  async function opened() {
    services.rows.set('p1', { row: row('p1', project('Un')) });
    const state = mount();
    await act(async () => { await state().openProject('p1'); });
    services.queueView.mockClear();
    return state;
  }

  it('changement de vue seule : vue enregistrée, projet jamais réécrit', async () => {
    const state = await opened();
    const current = state().activeProjectInitial!;
    act(() => state().handleProjectChange({ ...current, activeMode: 'rythme' }));
    await advance(5_000);
    expect(services.queueView).toHaveBeenCalledTimes(1);
    expect(services.calls.filter((call) => call.startsWith('save:'))).toEqual([]);
  });

  it('changement du document : projet enregistré, vue intacte', async () => {
    const state = await opened();
    act(() => state().handleProjectChange({ ...state().activeProjectInitial!, name: 'Renommé' }));
    await advance(1_000);
    expect(services.calls).toContain('save:p1:Renommé');
    expect(services.queueView).not.toHaveBeenCalled();
  });

  it('vue carte et panneaux : tenus par le Dashboard, jamais écrasés par la copie du store', async () => {
    const state = await opened();
    act(() => state().mutateActiveProjectDashboard((dashboard) => { dashboard.leftPanelWidth = 420; }));
    expect(services.queueView).toHaveBeenCalledTimes(1);
    act(() => state().mutateActiveProjectDashboard((dashboard) => { dashboard.leftPanelWidth = 420; }));
    expect(services.queueView).toHaveBeenCalledTimes(1);

    const stale = state().activeProjectInitial!;
    act(() => state().handleProjectChange({ ...stale, name: 'Renommé' }));
    expect(state().getActiveProjectSnapshot()?.dashboard?.leftPanelWidth).toBe(420);
    await advance(1_000);
    expect(services.calls.filter((call) => call.startsWith('save:'))).toEqual(['save:p1:Renommé']);
  });

  it('fermer le projet envoie ce qui reste et revient au gestionnaire', async () => {
    const state = await opened();
    act(() => state().handleProjectChange({ ...state().activeProjectInitial!, name: 'Dernier état' }));
    await act(async () => { await state().closeProject(); });
    expect(services.calls).toContain('save:p1:Dernier état');
    expect(services.flushViews).toHaveBeenCalledWith('p1');
    expect(state().activeProjectId).toBeNull();
    expect(state().projectBrowserOpen).toBe(true);
  });
});
