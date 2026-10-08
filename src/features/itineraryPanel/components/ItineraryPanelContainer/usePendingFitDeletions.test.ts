// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import type { Itinerary } from '../../types';

/**
 * Les fichiers FIT d'un itinéraire supprimé ne partent qu'à la fermeture du
 * projet, et seulement s'il ne les référence plus ; un changement de projet
 * ne supprime rien, un projet partagé non plus.
 */

const services = vi.hoisted(() => ({
  shared: new Set<string>(),
  scheduled: [] as Array<{ projectId: string; paths: Array<string | null> }>,
  flushed: [] as Array<{ projectId: string; ids: string[] }>,
}));

vi.mock('@/shared/services/projects', () => ({
  isServerOwnedDocument: (projectId: string) => services.shared.has(projectId),
  scheduleFitUploadsDeletion: (projectId: string, uploads: Array<{ path: string | null }>) => {
    services.scheduled.push({ projectId, paths: uploads.map((upload) => upload.path) });
  },
  flushPendingFitDeletions: async (projectId: string, project: { itineraries: Array<{ id: string }> }) => {
    services.flushed.push({ projectId, ids: project.itineraries.map((itinerary) => itinerary.id) });
    return 0;
  },
}));

const { usePendingFitDeletions } = await import('./usePendingFitDeletions');

const itinerary = (id: string, path: string | null = `${id}.fit`) =>
  ({ id, fitUploads: path ? [{ path, name: `${id}.fit` }] : [] }) as unknown as Itinerary;

type Props = { projectId: string | null; itineraries: Itinerary[] };
const mount = (props: Props) =>
  renderHook(({ projectId, itineraries }: Props) => usePendingFitDeletions(projectId, itineraries), { initialProps: props });

beforeEach(() => {
  services.shared.clear();
  services.scheduled = [];
  services.flushed = [];
});

describe('usePendingFitDeletions', () => {
  it('met en attente les fichiers d\'un itinéraire supprimé et vide l\'attente à la fermeture', () => {
    const a = itinerary('a');
    const b = itinerary('b');
    const hook = mount({ projectId: 'p1', itineraries: [a, b] });
    hook.rerender({ projectId: 'p1', itineraries: [a] });
    expect(services.scheduled).toEqual([{ projectId: 'p1', paths: ['b.fit'] }]);
    expect(services.flushed).toEqual([]);

    hook.unmount();
    expect(services.flushed).toEqual([{ projectId: 'p1', ids: ['a'] }]);
  });

  it('ne supprime rien quand on change de projet, et vide celui qu\'on quitte avec son dernier état', () => {
    const hook = mount({ projectId: 'p1', itineraries: [itinerary('a'), itinerary('b')] });
    hook.rerender({ projectId: 'p2', itineraries: [itinerary('z')] });
    expect(services.scheduled).toEqual([]);
    expect(services.flushed).toEqual([{ projectId: 'p1', ids: ['a', 'b'] }]);
    hook.unmount();
  });

  it('ne met rien en attente dans un projet partagé', () => {
    services.shared.add('p1');
    const hook = mount({ projectId: 'p1', itineraries: [itinerary('a'), itinerary('b')] });
    hook.rerender({ projectId: 'p1', itineraries: [itinerary('a')] });
    expect(services.scheduled).toEqual([]);
    hook.unmount();
  });

  it('vide l\'attente au pagehide', () => {
    const hook = mount({ projectId: 'p1', itineraries: [itinerary('a')] });
    window.dispatchEvent(new Event('pagehide'));
    expect(services.flushed).toEqual([{ projectId: 'p1', ids: ['a'] }]);
    hook.unmount();
  });
});
