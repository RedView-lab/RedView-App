// @vitest-environment happy-dom
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import type { Itinerary, ItineraryFitUpload, ItineraryProject } from '../../types';
import { useItineraryFitRuntime } from './index';

const projects = vi.hoisted(() => ({
  downloadProjectItineraryFitFileEntries: vi.fn(),
  deleteFitUploads: vi.fn(),
  uploadProjectItineraryFitFiles: vi.fn(),
}));
vi.mock('@/shared/services/projects', () => projects);
vi.mock('@/features/fitPredictor/engine/api', () => ({
  FitPredictionCancelledError: class extends Error {},
  createFitPredictionEngine: () => ({ terminate: () => {} }),
}));
vi.mock('@/features/fitPredictor/lib/fitFileValidation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/fitPredictor/lib/fitFileValidation')>()),
  validateFitFile: async () => null,
}));

function upload(name: string): ItineraryFitUpload {
  return { name, type: 'application/octet-stream', lastModified: 1, size: 3, path: `bucket/${name}` };
}

function itinerary(fitUploads: ItineraryFitUpload[]): Itinerary {
  // Pas de tracé : la prédiction automatique n'a rien à calculer, seule l'hydratation tourne.
  return { id: 'it-1', name: 'Boucle', fitUploads } as unknown as Itinerary;
}

function renderRuntime(active: Itinerary) {
  const setProject = vi.fn<(next: ItineraryProject | ((prev: ItineraryProject) => ItineraryProject)) => void>();
  const rendered = renderHook(
    (current: Itinerary) => useItineraryFitRuntime({ active: current, projectId: 'p-1', predictionStore: null, setProject }),
    { initialProps: active },
  );
  return { ...rendered, setProject };
}

/** Laisse les promesses de l'hydratation se régler et React valider leurs mises à jour. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('useItineraryFitRuntime — .fit hydration', () => {
  beforeEach(() => {
    projects.downloadProjectItineraryFitFileEntries.mockImplementation(async (uploads: ItineraryFitUpload[]) =>
      uploads.map((u) => ({ path: u.path, file: new File(['fit'], u.name) })),
    );
  });

  it('downloads the persisted files once and lists them', async () => {
    const { result } = renderRuntime(itinerary([upload('ride.fit')]));
    await flush();
    expect(projects.downloadProjectItineraryFitFileEntries).toHaveBeenCalledTimes(1);
    expect(result.current.fitFileNames).toEqual(['ride.fit']);
  });

  it('does not download again when the itinerary is re-created with the same uploads', async () => {
    const { result, rerender } = renderRuntime(itinerary([upload('ride.fit')]));
    await flush();
    // Même contenu, nouveaux objets (matérialisation collab, annulation, rechargement du projet).
    rerender(itinerary([upload('ride.fit')]));
    await flush();
    rerender({ ...itinerary([upload('ride.fit')]), name: 'Boucle renommée' } as Itinerary);
    await flush();
    expect(projects.downloadProjectItineraryFitFileEntries).toHaveBeenCalledTimes(1);
    expect(result.current.fitFileNames).toEqual(['ride.fit']);
  });

  it('does not cancel an in-flight download when the uploads array is re-created', async () => {
    let release!: () => void;
    projects.downloadProjectItineraryFitFileEntries.mockImplementationOnce(
      (uploads: ItineraryFitUpload[]) =>
        new Promise((resolve) => {
          release = () => resolve(uploads.map((u) => ({ path: u.path, file: new File(['fit'], u.name) })));
        }),
    );
    const { result, rerender } = renderRuntime(itinerary([upload('ride.fit')]));
    rerender(itinerary([upload('ride.fit')]));
    release();
    await flush();
    expect(projects.downloadProjectItineraryFitFileEntries).toHaveBeenCalledTimes(1);
    expect(result.current.fitFileNames).toEqual(['ride.fit']);
  });

  it('hydrates again when the persisted list really changes', async () => {
    const { result, rerender } = renderRuntime(itinerary([upload('ride.fit')]));
    await flush();
    rerender(itinerary([upload('ride.fit'), upload('climb.fit')]));
    await flush();
    expect(projects.downloadProjectItineraryFitFileEntries).toHaveBeenCalledTimes(2);
    expect(result.current.fitFileNames).toEqual(['ride.fit', 'climb.fit']);
  });
});
