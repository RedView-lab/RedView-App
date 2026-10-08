// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { ProjectCloudError } from '@/shared/services/projects/errors';
import { getProjectSyncStatus, subscribeProjectSyncStatus } from '@/shared/services/projects/syncStatus';
import { renderHook, type RenderedHook } from '@/shared/test/renderHook';

/**
 * Autosave du Dashboard : sauvegarde après une rafale (au plus tard 4 s),
 * état identique non renvoyé, nouvel essai silencieux hors ligne, conflit /
 * projet supprimé / trop gros qui suspendent l'envoi cloud (copie locale
 * seulement) jusqu'à une sauvegarde explicite ou un projet plus petit,
 * projet partagé jamais envoyé, copie locale immédiate à la fermeture.
 */

const cloud = vi.hoisted(() => ({
  save: vi.fn<(id: string, project: unknown, options?: { force?: boolean }) => Promise<void>>(),
  saveLocally: vi.fn<(id: string, project: unknown) => Promise<void>>(),
  serverOwned: new Set<string>(),
}));

vi.mock('@/shared/services/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/services/projects')>()),
  saveProject: cloud.save,
  saveProjectLocally: cloud.saveLocally,
  isServerOwnedDocument: (id: string) => cloud.serverOwned.has(id),
  flushProjectViews: async () => {},
  uploadProjectThumbnail: async () => {},
}));
vi.mock('@/shared/lib/projectLocation', () => ({ replaceProjectLocation: () => {} }));
vi.mock('@/shared/lib/mapThumbnail', () => ({ captureMapThumbnail: async () => null }));

const { useDashboardProjectSync } = await import('./useDashboardProjectSync');

type Sync = ReturnType<typeof useDashboardProjectSync>;
let hook: RenderedHook<null, Sync> | null = null;

function mount(projectId = 'p1'): Sync & { current: () => Sync } {
  const refs = {
    mapInstanceRef: { current: null },
    activeProjectIdRef: { current: projectId as string | null },
    activeProjectSnapshotRef: { current: null as ItineraryProject | null },
  };
  hook = renderHook(() => useDashboardProjectSync({ ...refs, activeProjectId: projectId }), { initialProps: null });
  const rendered = hook;
  return { ...rendered.result.current, current: () => rendered.result.current };
}

const project = (name: string): ItineraryProject => ({ ...createDefaultProject(), name });
const cloudSaves = () => cloud.save.mock.calls.length;

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  cloud.save.mockReset().mockResolvedValue(undefined);
  cloud.saveLocally.mockReset().mockResolvedValue(undefined);
  cloud.serverOwned.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  hook?.unmount();
  hook = null;
  vi.useRealTimers();
});

describe('regroupement des modifications', () => {
  it('une rafale part en une seule sauvegarde, 1 s après la dernière modification, avec le dernier état', async () => {
    const sync = mount();
    for (let i = 0; i < 5; i += 1) {
      act(() => sync.queueProjectSave(project(`v${i}`)));
      await advance(300);
    }
    expect(cloudSaves()).toBe(0);
    await advance(1_000);
    expect(cloudSaves()).toBe(1);
    expect((cloud.save.mock.calls[0]![1] as ItineraryProject).name).toBe('v4');
    expect(getProjectSyncStatus()).toMatchObject({ projectId: 'p1', state: 'saved' });
  });

  it('une édition continue est sauvegardée au moins toutes les 4 s', async () => {
    const sync = mount();
    for (let i = 0; i < 9; i += 1) {
      act(() => sync.queueProjectSave(project(`v${i}`)));
      await advance(500);
    }
    expect(cloudSaves()).toBeGreaterThanOrEqual(1);
  });

  it('un état identique au dernier envoyé n’est pas renvoyé', async () => {
    const sync = mount();
    act(() => sync.queueProjectSave(project('même')));
    await advance(1_000);
    act(() => sync.queueProjectSave(project('même')));
    await advance(1_000);
    expect(cloudSaves()).toBe(1);
  });
});

describe('échecs', () => {
  it('hors ligne : nouvel essai automatique (2 s, puis 5 s), sans repasser par « Enregistrement… »', async () => {
    const sync = mount();
    cloud.save.mockRejectedValue(new ProjectCloudError('offline'));
    act(() => sync.queueProjectSave(project('v1')));
    await advance(1_000);
    expect(getProjectSyncStatus().state).toBe('pending-offline');
    const states: string[] = [];
    const unsubscribe = subscribeProjectSyncStatus(() => states.push(getProjectSyncStatus().state));
    await advance(2_000);
    expect(cloudSaves()).toBe(2);
    expect(getProjectSyncStatus().state).toBe('pending-offline');
    cloud.save.mockResolvedValue(undefined);
    await advance(4_999);
    expect(cloudSaves()).toBe(2);
    await advance(1);
    expect(cloudSaves()).toBe(3);
    expect(getProjectSyncStatus().state).toBe('saved');
    unsubscribe();
    expect(states).not.toContain('saving');
  });

  it('retour du réseau : nouvel essai tout de suite', async () => {
    const sync = mount();
    cloud.save.mockRejectedValueOnce(new ProjectCloudError('offline'));
    act(() => sync.queueProjectSave(project('v1')));
    await advance(1_000);
    expect(cloudSaves()).toBe(1);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await advance(0);
    expect(cloudSaves()).toBe(2);
    expect(getProjectSyncStatus().state).toBe('saved');
  });

  it('conflit : les modifications suivantes restent sur l’appareil, seule une sauvegarde explicite retente le cloud', async () => {
    const sync = mount();
    cloud.save.mockRejectedValue(new ProjectCloudError('conflict'));
    act(() => sync.queueProjectSave(project('v1')));
    await advance(1_000);
    expect(getProjectSyncStatus()).toMatchObject({ state: 'error', errorKind: 'conflict' });

    act(() => sync.queueProjectSave(project('v2')));
    await advance(1_000);
    expect(cloudSaves()).toBe(1);
    expect(cloud.saveLocally).toHaveBeenCalledTimes(1);

    await act(async () => { await expect(sync.current().saveNow()).rejects.toMatchObject({ kind: 'conflict' }); });
    expect(cloudSaves()).toBe(2);

    cloud.save.mockResolvedValue(undefined);
    let saved: ItineraryProject | null = null;
    await act(async () => { saved = await sync.current().saveNow({ force: true }); });
    expect(cloud.save.mock.calls.at(-1)?.[2]).toMatchObject({ force: true });
    expect(saved!.savedAt).toEqual(expect.any(String));
    expect(getProjectSyncStatus().state).toBe('saved');
  });

  it('trop gros : l’autosave attend que le projet rétrécisse', async () => {
    const sync = mount();
    cloud.save.mockRejectedValueOnce(new ProjectCloudError('too-large'));
    const big = project(`gros ${'x'.repeat(5_000)}`);
    act(() => sync.queueProjectSave(big));
    await advance(1_000);
    act(() => sync.queueProjectSave({ ...big, name: `${big.name} bis` }));
    await advance(1_000);
    expect(cloudSaves()).toBe(1);
    expect(cloud.saveLocally).toHaveBeenCalledTimes(1);

    act(() => sync.queueProjectSave(project('petit')));
    await advance(1_000);
    expect(cloudSaves()).toBe(2);
    expect(getProjectSyncStatus().state).toBe('saved');
  });
});

describe('projet partagé, fermeture, changement de projet', () => {
  it('projet partagé ou en session : copie locale seulement, même pour Enregistrer', async () => {
    cloud.serverOwned.add('p1');
    const sync = mount();
    act(() => sync.queueProjectSave(project('v1')));
    await advance(1_000);
    await act(async () => { await sync.current().saveNow(); });
    expect(cloudSaves()).toBe(0);
    expect(cloud.saveLocally).toHaveBeenCalledTimes(2);
  });

  it('fermeture ou onglet masqué : copie locale tout de suite, sans attendre le regroupement', async () => {
    const sync = mount();
    act(() => sync.queueProjectSave(project('avant fermeture')));
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(cloud.saveLocally).toHaveBeenCalledWith('p1', expect.objectContaining({ name: 'avant fermeture' }));
  });

  it('changer de projet abandonne l’envoi en attente : une sauvegarde explicite reçoit une erreur, rien ne part', async () => {
    const sync = mount();
    cloud.save.mockImplementation(() => new Promise(() => {}));
    act(() => sync.queueProjectSave(project('v1')));
    await advance(1_000);
    let outcome: unknown = null;
    const pending = sync.current().saveNow().catch((error: unknown) => { outcome = error; });
    act(() => sync.current().resetSyncState('p2', null));
    await act(async () => { await pending; });
    expect(outcome).toMatchObject({ kind: 'offline' });
    expect(getProjectSyncStatus()).toMatchObject({ projectId: 'p2', state: 'idle' });
  });
});
