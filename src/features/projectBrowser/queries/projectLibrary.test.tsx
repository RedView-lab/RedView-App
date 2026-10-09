// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, type RenderedHook } from '@/shared/test/renderHook';

/**
 * Après un échec d'une action du gestionnaire de projets, la liste est relue
 * (projet supprimé dans un autre onglet, dossier supprimé à moitié, session
 * expirée) ; après un succès, le cache est mis à jour sans relecture.
 */

const services = vi.hoisted(() => ({
  renameProject: vi.fn<(id: string, name: string) => Promise<void>>(),
  deleteProjectFolder: vi.fn<(id: string) => Promise<void>>(),
}));
vi.mock('@/shared/services/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/services/projects')>()),
  renameProject: services.renameProject,
  deleteProjectFolder: services.deleteProjectFolder,
}));
vi.mock('@/shared/lib/notify', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const { projectLibraryKeys, useDeleteFolder, useRenameProject } = await import('./projectLibrary');

let client: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;
let hook: RenderedHook<null, unknown> | null = null;

function mount<T>(useHook: () => T): () => T {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const rendered = renderHook(useHook, { initialProps: null, wrapper });
  hook = rendered as RenderedHook<null, unknown>;
  return () => rendered.result.current;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(projectLibraryKeys.list('u1'), { folders: [], projects: [], sharedProjects: [], fetchedAt: 1 });
  invalidate = vi.spyOn(client, 'invalidateQueries');
  services.renameProject.mockReset();
  services.deleteProjectFolder.mockReset();
});

afterEach(() => {
  hook?.unmount();
  hook = null;
});

describe('gestionnaire de projets : liste relue après un échec', () => {
  it('renommer un projet supprimé ailleurs (404) : la liste est relue', async () => {
    const rename = mount(() => useRenameProject('u1'));
    services.renameProject.mockRejectedValue(Object.assign(new Error('not found'), { kind: 'not-found' }));
    await act(async () => {
      await rename().mutateAsync({ id: 'p1', name: 'Nouveau' }).catch(() => undefined);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectLibraryKeys.list('u1') });
  });

  it('renommage réussi : cache mis à jour, pas de relecture', async () => {
    const rename = mount(() => useRenameProject('u1'));
    services.renameProject.mockResolvedValue();
    await act(async () => {
      await rename().mutateAsync({ id: 'p1', name: 'Nouveau' });
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('dossier supprimé à moitié (réseau coupé en route) : la liste est relue', async () => {
    const remove = mount(() => useDeleteFolder('u1'));
    services.deleteProjectFolder.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => {
      await remove().mutateAsync({ id: 'f1' }).catch(() => undefined);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectLibraryKeys.list('u1') });
  });
});
