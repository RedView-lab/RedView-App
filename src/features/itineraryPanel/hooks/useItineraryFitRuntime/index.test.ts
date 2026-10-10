// @vitest-environment happy-dom
import { act, type ChangeEvent } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import type { Itinerary, ItineraryFitUpload, ItineraryProject } from '../../types';
import { useItineraryFitRuntime } from './index';

const projects = vi.hoisted(() => ({
  downloadProjectItineraryFitFileEntries: vi.fn(),
  deleteFitUploads: vi.fn(),
  uploadProjectItineraryFitFiles: vi.fn(),
  isServerOwnedDocument: vi.fn((_projectId: string) => false),
}));
vi.mock('@/shared/services/projects', () => projects);
const sharing = vi.hoisted(() => ({ fetchMissingFitFiles: vi.fn<(projectId: string, ids: string[]) => Promise<string[]>>() }));
vi.mock('@/shared/services/projects/sharing', () => sharing);
// Accord aux données de santé : donné, sauf dans le test qui le retire.
const consent = vi.hoisted(() => ({ accepted: true }));
vi.mock('@/shared/services/healthDataConsent', () => ({
  ensureHealthDataConsent: async () => consent.accepted,
  runWithHealthDataConsent: (action: () => void) => { if (consent.accepted) action(); },
}));
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

/**
 * Upload introuvable (404) : retiré du projet seulement hors partage. Dans un
 * projet partagé, Appwrite répond aussi 404 pour un fichier qu'on n'a pas le
 * droit de lire — le retirer l'effaçait pour tous les éditeurs. Ajouter ou
 * retirer un autre .fit ne touche jamais à un upload que cet appareil n'a pas
 * chargé (ni dans le projet, ni dans le bucket).
 */
describe('useItineraryFitRuntime — uploads introuvables ou illisibles', () => {
  const fileOf = (u: ItineraryFitUpload) => new File(['fit'], u.name, { lastModified: u.lastModified });
  const ride = upload('ride.fit');
  const other = upload('autre-editeur.fit');

  beforeEach(() => {
    projects.downloadProjectItineraryFitFileEntries.mockReset();
    projects.deleteFitUploads.mockReset();
    projects.uploadProjectItineraryFitFiles.mockReset();
    projects.isServerOwnedDocument.mockReset();
    sharing.fetchMissingFitFiles.mockReset().mockResolvedValue([]);
    projects.downloadProjectItineraryFitFileEntries.mockImplementation(async (uploads: ItineraryFitUpload[]) =>
      uploads.map((u) => (u === other || u.path === other.path
        ? { path: u.path, name: u.name, file: null, notFound: true }
        : { path: u.path, name: u.name, file: fileOf(u), notFound: false })),
    );
  });

  /** Applique le dernier `setProject(updater)` à un projet qui contient `active`. */
  function lastProjectUpdate(setProject: ReturnType<typeof renderRuntime>['setProject'], active: Itinerary) {
    const updater = setProject.mock.calls.at(-1)?.[0];
    expect(typeof updater).toBe('function');
    return (updater as (prev: ItineraryProject) => ItineraryProject)({ itineraries: [active] } as unknown as ItineraryProject);
  }

  it('projet non partagé : l’upload introuvable est retiré du projet', async () => {
    projects.isServerOwnedDocument.mockReturnValue(false);
    const active = itinerary([ride, other]);
    const { setProject } = renderRuntime(active);
    await flush();
    expect(lastProjectUpdate(setProject, active).itineraries[0]!.fitUploads).toEqual([ride]);
  });

  it('projet partagé : l’upload illisible reste, et n’est pas re-téléchargé tant que la liste ne change pas', async () => {
    projects.isServerOwnedDocument.mockReturnValue(true);
    const { result, rerender, setProject } = renderRuntime(itinerary([ride, other]));
    await flush();
    expect(setProject).not.toHaveBeenCalled();
    expect(result.current.fitFileNames).toEqual(['ride.fit']);
    rerender(itinerary([ride, other]));
    await flush();
    expect(projects.downloadProjectItineraryFitFileEntries).toHaveBeenCalledTimes(1);
  });

  it('projet partagé : un upload que le serveur dit supprimé est retiré, un illisible reste', async () => {
    projects.isServerOwnedDocument.mockReturnValue(true);
    const deleted = upload('supprime.fit');
    projects.downloadProjectItineraryFitFileEntries.mockImplementation(async (uploads: ItineraryFitUpload[]) =>
      uploads.map((u) => (u.path === ride.path
        ? { path: u.path, name: u.name, file: fileOf(u), notFound: false }
        : { path: u.path, name: u.name, file: null, notFound: true })),
    );
    sharing.fetchMissingFitFiles.mockResolvedValue([deleted.path!]);
    const active = itinerary([ride, other, deleted]);
    const { setProject } = renderRuntime(active);
    await flush();
    expect(sharing.fetchMissingFitFiles).toHaveBeenCalledWith('p-1', [other.path, deleted.path]);
    expect(lastProjectUpdate(setProject, active).itineraries[0]!.fitUploads).toEqual([ride, other]);
  });

  it('projet partagé, serveur injoignable : aucun upload n’est retiré', async () => {
    projects.isServerOwnedDocument.mockReturnValue(true);
    sharing.fetchMissingFitFiles.mockRejectedValue(new Error('hors ligne'));
    const { setProject } = renderRuntime(itinerary([ride, other]));
    await flush();
    expect(setProject).not.toHaveBeenCalled();
  });

  it('retirer un .fit garde l’upload non chargé ici et ne supprime que le fichier retiré', async () => {
    projects.isServerOwnedDocument.mockReturnValue(true);
    const active = itinerary([ride, other]);
    const { result, setProject } = renderRuntime(active);
    await flush();
    act(() => result.current.handleRemoveFitFile(0));
    expect(projects.deleteFitUploads).toHaveBeenCalledWith([ride]);
    expect(lastProjectUpdate(setProject, active).itineraries[0]!.fitUploads).toEqual([other]);
  });

  it('ajouter un .fit garde l’upload non chargé ici', async () => {
    projects.isServerOwnedDocument.mockReturnValue(true);
    const added = upload('nouveau.fit');
    projects.uploadProjectItineraryFitFiles.mockResolvedValue({ uploads: [added], failed: [] });
    const active = itinerary([ride, other]);
    const { result, setProject } = renderRuntime(active);
    await flush();
    const event = { target: { files: [fileOf(added)] } } as unknown as ChangeEvent<HTMLInputElement>;
    await act(async () => {
      await result.current.handleFitInputChange(event);
    });
    expect(projects.uploadProjectItineraryFitFiles).toHaveBeenCalledWith('p-1', 'it-1', [expect.objectContaining({ name: 'nouveau.fit' })]);
    expect(lastProjectUpdate(setProject, active).itineraries[0]!.fitUploads).toEqual([ride, added, other]);
  });

  it('fichiers choisis sans accord confirmé (retiré ailleurs, non enregistré) : rien n’est lu ni envoyé (A10-2)', async () => {
    consent.accepted = false;
    try {
      const added = upload('nouveau.fit');
      const active = itinerary([ride]);
      const { result } = renderRuntime(active);
      await flush();
      const event = { target: { files: [fileOf(added)] } } as unknown as ChangeEvent<HTMLInputElement>;
      await act(async () => {
        await result.current.handleFitInputChange(event);
      });
      expect(projects.uploadProjectItineraryFitFiles).not.toHaveBeenCalled();
    } finally {
      consent.accepted = true;
    }
  });
});
