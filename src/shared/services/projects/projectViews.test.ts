import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { extractProjectView, type ProjectViewState } from '@/features/itineraryPanel/lib/project/layers';
import { loadProjectPersistence } from '@/shared/test/projectPersistence';

/**
 * Vue de chaque utilisateur sur un projet (projectViews.ts) : copie locale
 * presque tout de suite, cloud regroupé, dernière écriture gagnante à la
 * lecture, amorçage qui ne remplace jamais une vraie vue, collection absente
 * sans rien bloquer.
 */

vi.mock('appwrite', () => import('@/shared/test/mockAppwriteSdk'));

const ME = 'user-A';

async function load() {
  const harness = await loadProjectPersistence(ME);
  const views = await import('./projectViews');
  return { ...harness, views, docId: (projectId: string) => views.projectViewDocumentId(projectId, ME) };
}

// Graphe de modules (persistance, faux SDK, fake-indexeddb) transformé une fois
// ici, hors du délai de 5 s des tests : sous la charge de `npm run check`, le
// premier test le payait seul et dépassait ce délai. Chaque test recharge
// toujours des modules neufs (loadProjectPersistence → resetModules).
beforeAll(async () => {
  await load();
}, 60_000);

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

describe('lu / non lu des commentaires entre appareils (E3-2)', () => {
  type Reads = NonNullable<NonNullable<ProjectViewState['commentsView']>['reads']>;
  const withReads = (activeItineraryId: string, reads: Reads): ProjectViewState => ({
    ...view(activeItineraryId),
    commentsView: { sort: 'date', reads },
  });
  const OLD = { m: 'm1', t: '2026-10-01T10:00:00.000Z' };
  const NEW = { m: 'm3', t: '2026-10-02T10:00:00.000Z' };

  it('un appareil resté sur une vue ancienne ne remet pas « non lus » les fils lus ailleurs', async () => {
    const { mock, otherDevice, views, docId } = await load();
    await views.saveProjectViewNow('p1', withReads('fixe', { f1: OLD }));
    // Le portable lit f1 jusqu'à son dernier message et lit f2.
    await otherDevice.updateDocument('db', 'project_views', docId('p1'), {
      data: JSON.stringify({ updatedAt: '2026-10-02T11:00:00.000Z', view: withReads('portable', { f1: NEW, f2: NEW }) }),
    });
    // Le fixe déplace la carte : sa vue part, avec ses anciens repères de lecture.
    mock.calls = [];
    await views.saveProjectViewNow('p1', withReads('fixe déplacé', { f1: OLD, f3: OLD }));
    // Écriture conditionnelle refusée (le portable a écrit depuis), relue, fusionnée, réécrite.
    expect(mock.calls.filter((call) => call.endsWith(':project_views'))).toEqual([
      'updateDocument:project_views', 'getDocument:project_views', 'updateDocument:project_views',
    ]);
    const stored = storedView(mock.col('project_views').get(docId('p1'))?.data);
    expect(stored.activeItineraryId).toBe('fixe déplacé');
    expect(stored.commentsView?.reads).toEqual({ f1: NEW, f2: NEW, f3: OLD });
    expect(stored.commentsView?.sort).toBe('date');
  });

  it('à la lecture, les repères les plus avancés de chaque copie sont gardés', async () => {
    const { otherDevice, idb, views, docId } = await load();
    await views.saveProjectViewNow('p1', withReads('ici', { f1: OLD }));
    await otherDevice.updateDocument('db', 'project_views', docId('p1'), {
      data: JSON.stringify({ updatedAt: '2026-10-02T11:00:00.000Z', view: withReads('ailleurs', { f1: NEW, f2: NEW }) }),
    });
    // Copie locale plus récente (carte déplacée ici), repères plus anciens.
    await idb.idbSaveProjectView({ projectId: 'p1', ownerId: ME, updatedAt: '2100-01-01T00:00:00.000Z', view: withReads('local récent', { f1: OLD, f3: OLD }) });
    const read = await views.readProjectView('p1');
    expect(read?.view.activeItineraryId).toBe('local récent');
    expect(read?.view.commentsView?.reads).toEqual({ f1: NEW, f2: NEW, f3: OLD });
  });
});

describe('aucune requête qui répond 404 (rouge dans la console)', () => {
  const viewCalls = (calls: string[]) => calls.filter((call) => call.endsWith(':project_views'));

  it('projet ouvert sans vue : une liste vide, puis création, puis mises à jour', async () => {
    const { mock, views } = await load();
    expect(await views.readProjectView('p1')).toBeNull();
    await views.saveProjectViewNow('p1', view('a'));
    await views.saveProjectViewNow('p1', view('b'));
    expect(viewCalls(mock.calls)).toEqual([
      'listDocuments:project_views',
      'createDocument:project_views',
      // Écriture conditionnelle sur la version connue : pas de relecture (E3-2).
      'updateDocument:project_views',
    ]);
  });

  it('projet ouvert avec une vue : mise à jour de celle trouvée, à son id', async () => {
    const { mock, otherDevice, views, docId } = await load();
    await otherDevice.createDocument('db', 'project_views', docId('p1'), {
      project_id: 'p1', user_id: ME, data: JSON.stringify({ updatedAt: '2026-10-01T00:00:00.000Z', view: view('ailleurs') }),
    }, [`read("user:${ME}")`, `update("user:${ME}")`, `delete("user:${ME}")`]);
    mock.calls = [];
    expect((await views.readProjectView('p1'))?.view.activeItineraryId).toBe('ailleurs');
    await views.saveProjectViewNow('p1', view('ici'));
    expect(viewCalls(mock.calls)).toEqual(['listDocuments:project_views', 'updateDocument:project_views']);
    expect(storedView(mock.col('project_views').get(docId('p1'))?.data).activeItineraryId).toBe('ici');
  });

  it('projet tout juste créé (vue jamais lue) : création directe ; sa suppression retrouve la vue', async () => {
    const { mock, views, docId } = await load();
    await views.saveProjectViewNow('p1', view('a'));
    expect(viewCalls(mock.calls)).toEqual(['createDocument:project_views']);

    mock.calls = [];
    await views.deleteProjectView('p2'); // jamais lue ni écrite, absente du cloud
    expect(viewCalls(mock.calls)).toEqual(['listDocuments:project_views']);
    await views.deleteProjectView('p1');
    expect(mock.col('project_views').has(docId('p1'))).toBe(false);
  });

  it('vue créée entre-temps par un autre appareil : le 409 la met à jour', async () => {
    const { mock, otherDevice, views, docId } = await load();
    expect(await views.readProjectView('p1')).toBeNull();
    await otherDevice.createDocument('db', 'project_views', docId('p1'), {
      project_id: 'p1', user_id: ME, data: JSON.stringify({ updatedAt: '2026-10-01T00:00:00.000Z', view: view('ailleurs') }),
    }, [`read("user:${ME}")`, `update("user:${ME}")`, `delete("user:${ME}")`]);
    await views.saveProjectViewNow('p1', view('ici'));
    expect(storedView(mock.col('project_views').get(docId('p1'))?.data).activeItineraryId).toBe('ici');
    mock.calls = [];
    await views.saveProjectViewNow('p1', view('encore'));
    // Écrite sans condition après le 409 : version inconnue, relue une fois.
    expect(viewCalls(mock.calls)).toEqual(['getDocument:project_views', 'updateDocument:project_views']);
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
