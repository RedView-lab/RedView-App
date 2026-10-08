import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { extractProjectView, type ProjectViewState } from '@/features/itineraryPanel/lib/project/layers';
import { loadProjectPersistence } from '@/shared/test/projectPersistence';

/**
 * Vue de chaque utilisateur sur un projet (projectViews.ts) : copie locale
 * presque tout de suite, cloud regroupé, dernière écriture gagnante à la
 * lecture, amorçage qui ne remplace jamais une vraie vue, collection absente
 * sans rien bloquer.
 */

vi.mock('appwrite', () => import('../../../../script-test-bench/audit/a-mock-appwrite-sdk'));

const ME = 'user-A';

async function load() {
  const harness = await loadProjectPersistence(ME);
  const views = await import('./projectViews');
  return { ...harness, views, docId: (projectId: string) => views.projectViewDocumentId(projectId, ME) };
}

const baseView = extractProjectView(createDefaultProject());
const view = (activeItineraryId: string): ProjectViewState => ({ ...baseView, activeItineraryId });
const cloudWrites = (calls: string[]) => calls.filter((call) => /^(create|update)Document:project_views$/.test(call)).length;
const storedView = (data: unknown) => (JSON.parse(String(data)) as { view: ProjectViewState }).view;

afterEach(() => {
  vi.useRealTimers();
});

describe('queueProjectViewSave', () => {
  it('copie locale en quelques centaines de ms, un seul envoi cloud après une pause des changements', async () => {
    const { mock, idb, views, docId } = await load();
    await views.saveProjectViewNow('p1', view('initiale'));
    mock.calls = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (let i = 0; i < 10; i += 1) {
      views.queueProjectViewSave('p1', view(`it${i}`));
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(300);
    expect((await idb.idbGetProjectView('p1'))?.view.activeItineraryId).toBe('it9');
    expect(cloudWrites(mock.calls)).toBe(0);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(cloudWrites(mock.calls)).toBe(1);
    expect(storedView(mock.col('project_views').get(docId('p1'))?.data).activeItineraryId).toBe('it9');
  });

  it('des changements continus partent quand même au cloud au bout de 20 s', async () => {
    const { mock, views } = await load();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (let i = 0; i < 21; i += 1) {
      views.queueProjectViewSave('p1', view(`it${i}`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(cloudWrites(mock.calls)).toBeGreaterThanOrEqual(1);
  });

  it('une vue inchangée n’est pas réécrite', async () => {
    const { mock, views } = await load();
    await views.saveProjectViewNow('p1', view('a'));
    const before = cloudWrites(mock.calls);
    await views.saveProjectViewNow('p1', view('a'));
    expect(cloudWrites(mock.calls)).toBe(before);
  });
});

describe('readProjectView', () => {
  it('la plus récente gagne : vue cloud d’un autre appareil, puis copie locale plus récente', async () => {
    const { otherDevice, idb, views, docId } = await load();
    await views.saveProjectViewNow('p1', view('ici'));
    await otherDevice.updateDocument('db', 'project_views', docId('p1'), {
      data: JSON.stringify({ updatedAt: '2099-01-01T00:00:00.000Z', view: view('ailleurs') }),
    });
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('ailleurs');
    // Mise en cache locale de la vue cloud plus récente.
    await vi.waitFor(async () => expect((await idb.idbGetProjectView('p1'))?.view.activeItineraryId).toBe('ailleurs'));

    await idb.idbSaveProjectView({ projectId: 'p1', ownerId: ME, updatedAt: '2100-01-01T00:00:00.000Z', view: view('local récent') });
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('local récent');
  });

  it('une vue en attente d’écriture compte, mais une copie locale plus récente (autre onglet) l’emporte', async () => {
    const { idb, views } = await load();
    views.queueProjectViewSave('p1', view('en attente'));
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('en attente');
    await idb.idbSaveProjectView({ projectId: 'p1', ownerId: ME, updatedAt: '2100-01-01T00:00:00.000Z', view: view('autre onglet') });
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('autre onglet');
    await views.deleteProjectView('p1');
  });

  it('ignore le document de vue d’un autre compte posé à mon identifiant', async () => {
    const { mock, views, docId } = await load();
    mock.col('project_views').set(docId('p1'), {
      $id: docId('p1'), $createdAt: '2026-10-01T00:00:00Z', $updatedAt: '2026-10-01T00:00:00Z',
      $permissions: ['read("any")', 'update("user:intrus")', 'delete("user:intrus")'],
      project_id: 'p1', user_id: ME, data: JSON.stringify({ updatedAt: '2099-01-01T00:00:00.000Z', view: view('piégée') }),
    });
    expect(await views.readProjectView('p1')).toBeNull();
  });

  it('hors ligne : la copie locale sert', async () => {
    const { mock, views } = await load();
    await views.saveProjectViewNow('p1', view('locale'));
    mock.dbNetworkDown = true;
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('locale');
  });
});

describe('amorçage, collection absente, suppression', () => {
  it('une vue d’amorçage (ancien format) ne remplace jamais une vue cloud existante', async () => {
    const { mock, views, docId } = await load();
    await views.saveProjectViewNow('p1', view('vraie'));
    views.queueProjectViewSave('p1', view('amorce'), { seed: { updatedAt: '2020-01-01T00:00:00.000Z' } });
    await views.flushProjectViews('p1');
    expect(storedView(mock.col('project_views').get(docId('p1'))?.data).activeItineraryId).toBe('vraie');

    // Sans vue cloud, l'amorce est créée.
    views.queueProjectViewSave('p2', view('amorce'), { seed: { updatedAt: '2020-01-01T00:00:00.000Z' } });
    await views.flushProjectViews('p2');
    expect(storedView(mock.col('project_views').get(docId('p2'))?.data).activeItineraryId).toBe('amorce');
  });

  it('collection absente côté serveur : la vue reste sur l’appareil, sans erreur ni nouvel essai', async () => {
    const { mock, views } = await load();
    mock.missingCollections.add('project_views');
    await views.saveProjectViewNow('p1', view('a'));
    mock.calls = [];
    await views.saveProjectViewNow('p1', view('b'));
    expect(mock.calls.filter((call) => call.endsWith(':project_views'))).toEqual([]);
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('b');
  });

  it('supprimer la vue l’efface sur l’appareil et dans le cloud', async () => {
    const { mock, idb, views, docId } = await load();
    await views.saveProjectViewNow('p1', view('a'));
    await views.deleteProjectView('p1');
    expect(await idb.idbGetProjectView('p1')).toBeNull();
    expect(mock.col('project_views').has(docId('p1'))).toBe(false);
  });

  it('un même projet et un même compte donnent le même document sur tous les appareils, un autre compte un autre', async () => {
    const { views } = await load();
    const id = views.projectViewDocumentId('projet', 'compte');
    expect(views.projectViewDocumentId('projet', 'compte')).toBe(id);
    expect(views.projectViewDocumentId('projet', 'autre')).not.toBe(id);
    expect(id).toMatch(/^[a-z0-9]{1,36}$/);
  });
});
