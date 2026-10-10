// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, type RenderedHook } from '@/shared/test/renderHook';

/**
 * Quitter un projet partagé : il sort de « Partagés avec moi » et sa copie
 * sur l'appareil est effacée (le document du propriétaire n'y restait jamais
 * nettoyé : le projet n'est plus jamais rouvert).
 */

const services = vi.hoisted(() => ({
  leaveSharedProject: vi.fn<(id: string) => Promise<void>>(),
  forgetProjectOnDevice: vi.fn<(id: string) => Promise<void>>(async () => {}),
}));
vi.mock('@/shared/services/projects/sharing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/services/projects/sharing')>()),
  leaveSharedProject: services.leaveSharedProject,
}));
vi.mock('@/shared/services/projects/projectRows', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/services/projects/projectRows')>()),
  forgetProjectOnDevice: services.forgetProjectOnDevice,
}));

const { projectLibraryKeys } = await import('./projectLibrary');
const { useLeaveSharedProject } = await import('./projectSharing');

let client: QueryClient;
let hook: RenderedHook<null, unknown> | null = null;

function mount<T>(useHook: () => T): () => T {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const rendered = renderHook(useHook, { initialProps: null, wrapper });
  hook = rendered as RenderedHook<null, unknown>;
  return () => rendered.result.current;
}

const shared = { id: 'p1', name: 'Tour', sharedWithMe: true };

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(projectLibraryKeys.list('u1'), { folders: [], projects: [], sharedProjects: [shared], fetchedAt: 1 });
  services.leaveSharedProject.mockReset();
  services.forgetProjectOnDevice.mockClear();
});

afterEach(() => {
  hook?.unmount();
  hook = null;
});

describe('quitter un projet partagé', () => {
  it('le projet sort de la liste et sa copie sur l’appareil est effacée', async () => {
    services.leaveSharedProject.mockResolvedValue();
    const leave = mount(() => useLeaveSharedProject('u1'));
    await act(async () => {
      await leave().mutateAsync({ id: 'p1' });
    });
    expect(client.getQueryData<{ sharedProjects: unknown[] }>(projectLibraryKeys.list('u1'))?.sharedProjects).toEqual([]);
    expect(services.forgetProjectOnDevice).toHaveBeenCalledWith('p1');
  });

  it('départ refusé : rien n’est effacé', async () => {
    services.leaveSharedProject.mockRejectedValue(new Error('hors ligne'));
    const leave = mount(() => useLeaveSharedProject('u1'));
    await act(async () => {
      await leave().mutateAsync({ id: 'p1' }).catch(() => undefined);
    });
    expect(services.forgetProjectOnDevice).not.toHaveBeenCalled();
    expect(client.getQueryData<{ sharedProjects: unknown[] }>(projectLibraryKeys.list('u1'))?.sharedProjects).toHaveLength(1);
  });
});
