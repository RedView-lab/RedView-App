import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultItinerary, createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { loadProjectPersistence, reloadProjectSession as reloadTab, type MockAppwriteSdk as MockSdk } from '@/shared/test/projectPersistence';

/**
 * Règles de persistance des projets (projectRows.ts) sur le vrai code : faux
 * SDK Appwrite en mémoire du banc de persistance
 * (script-test-bench/audit/a-mock-appwrite-sdk.ts), vraie copie IndexedDB
 * (fake-indexeddb). Un « autre appareil » écrit directement dans le faux
 * Appwrite.
 */

const limits = vi.hoisted(() => ({ payloadChars: 12_000_000 }));

vi.mock('appwrite', () => import('../../../../script-test-bench/audit/a-mock-appwrite-sdk'));
vi.mock('./limits', async (importOriginal) => {
  const original = await importOriginal<typeof import('./limits')>();
  return {
    ...original,
    get MAX_CLOUD_PROJECT_PAYLOAD_CHARS() {
      return limits.payloadChars;
    },
  };
});

const ME = 'user-A';

async function load() {
  return {
    ...(await loadProjectPersistence(ME)),
    rows: await import('./projectRows'),
    live: await import('./liveSessions'),
  };
}

const project = (name: string) => ({ ...createDefaultProject(), name });
const updates = (mock: MockSdk['__mock']) => mock.calls.filter((call) => call === 'updateDocument:projects').length;
const cloudDoc = (mock: MockSdk['__mock'], id: string) => mock.col('projects').get(id) as Record<string, unknown> & { $updatedAt: string };
const kindOf = (error: unknown) => (error as { kind?: string }).kind;

beforeEach(() => {
  limits.payloadChars = 12_000_000;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('saveProject', () => {
  it('écrit la copie locale avant le cloud, ne la marque propre qu’après confirmation, et la resynchronise', async () => {
    const { mock, rows, idb } = await load();
    const row = await rows.createProject('Départ');

    mock.dbNetworkDown = true;
    await expect(rows.saveProject(row.id, project('Hors ligne'))).rejects.toSatisfy((error) => kindOf(error) === 'offline');
    const pending = await idb.idbGetProject(row.id);
    expect(pending?.dirty).toBe(true);
    expect(pending?.data.name).toBe('Hors ligne');
    expect((await rows.listDirtyProjects()).map((meta) => meta.id)).toEqual([row.id]);

    mock.dbNetworkDown = false;
    expect(await rows.syncDirtyProjects()).toEqual([]);
    expect(cloudDoc(mock, row.id).name).toBe('Hors ligne');
    const synced = await idb.idbGetProjectMeta(row.id);
    expect(synced?.dirty).toBe(false);
    expect(synced?.cloud_updated_at).toBe(cloudDoc(mock, row.id).$updatedAt);
  });

  it('ne renvoie pas un document que le cloud a déjà confirmé', async () => {
    const { mock, rows } = await load();
    const row = await rows.createProject('Même');
    const edited = project('Modifié');
    await rows.saveProject(row.id, edited);
    await rows.saveProject(row.id, edited);
    expect(updates(mock)).toBe(1);
  });

  it('refuse d’écraser une version modifiée sur un autre appareil, sauf choix explicite', async () => {
    const { mock, otherDevice, rows } = await load();
    const row = await rows.createProject('Commun');
    await otherDevice.updateDocument('db', 'projects', row.id, { name: 'Autre appareil' });

    await expect(rows.saveProject(row.id, project('Ici'))).rejects.toSatisfy((error) => kindOf(error) === 'conflict');
    expect(cloudDoc(mock, row.id).name).toBe('Autre appareil');

    await rows.saveProject(row.id, project('Ici'), { force: true });
    expect(cloudDoc(mock, row.id).name).toBe('Ici');
  });

  it('un renommage fait avancer la version de base : pas de faux conflit ensuite', async () => {
    const { mock, rows } = await load();
    const row = await rows.createProject('Avant');
    await rows.renameProject(row.id, 'Renommé');
    await rows.saveProject(row.id, project('Renommé puis modifié'));
    expect(cloudDoc(mock, row.id).name).toBe('Renommé puis modifié');
  });

  it('envoie les sauvegardes d’un projet dans l’ordre des appels, même si la première est lente', async () => {
    const { mock, rows } = await load();
    const row = await rows.createProject('File');
    mock.updateLatencyQueue = [150, 0];
    await Promise.all([rows.saveProject(row.id, project('v1')), rows.saveProject(row.id, project('v2'))]);
    expect(cloudDoc(mock, row.id).name).toBe('v2');
  });

  it('projet partagé ou en session : jamais écrit au cloud, copie locale jamais à resynchroniser', async () => {
    const { mock, rows, idb, live } = await load();
    const shared = await rows.createProject('Partagé');
    const inSession = await rows.createProject('En session');
    live.markSharedProject(shared.id, `p${shared.id}`, ME);
    const release = live.registerLiveSession(inSession.id);
    mock.calls = [];

    await rows.saveProject(shared.id, project('Partagé modifié'));
    await rows.saveProject(inSession.id, project('Session modifiée'));
    await rows.saveProjectLocally(inSession.id, project('Session fermée'));

    expect(updates(mock)).toBe(0);
    expect(cloudDoc(mock, shared.id).name).toBe('Partagé');
    expect((await idb.idbGetProjectMeta(shared.id))?.dirty).toBe(false);
    expect((await idb.idbGetProjectMeta(inSession.id))?.dirty).toBe(false);
    expect((await idb.idbGetProject(inSession.id))?.data.name).toBe('Session fermée');
    expect(await rows.listDirtyProjects()).toEqual([]);
    release();
  });

  it('une charge trop grosse pour le document part dans le bucket, un seul fichier par projet', async () => {
    const { mock, rows, idb } = await load();
    limits.payloadChars = 64;
    const row = await rows.createProject('Gros');
    expect(String(cloudDoc(mock, row.id).data)).toMatch(/^file:/);

    await rows.saveProject(row.id, project('Gros modifié'));
    const pointer = String(cloudDoc(mock, row.id).data);
    expect(pointer).toMatch(/^file:/);
    const files = [...mock.files.values()].filter((file) => file.bucket === 'project-payloads');
    expect(files).toHaveLength(1);

    // Ouverture sans copie locale (autre appareil) : le document est relu en entier depuis le fichier.
    await idb.idbDeleteProject(row.id);
    expect((await rows.getProject(row.id))?.data.name).toBe('Gros modifié');
  });
});

describe('getProject', () => {
  it('copie locale propre, cloud modifié ailleurs : ouvre la version du cloud', async () => {
    const { otherDevice, rows, idb } = await load();
    const row = await rows.createProject('Ancien');
    await vi.waitFor(async () => expect(await idb.idbGetProjectMeta(row.id)).not.toBeNull());
    const doc = await otherDevice.getDocument('db', 'projects', row.id);
    await otherDevice.updateDocument('db', 'projects', row.id, { name: 'Distant', data: doc.data });
    expect((await rows.getProject(row.id))?.name).toBe('Distant');
  });

  it('modifications locales non envoyées plus récentes que le cloud : la version du cloud est gardée en copie', async () => {
    const { mock, otherDevice, rows, idb } = await load();
    const row = await rows.createProject('Commun');
    mock.dbNetworkDown = true;
    await rows.saveProject(row.id, project('Local non envoyé')).catch(() => undefined);
    mock.dbNetworkDown = false;
    await otherDevice.updateDocument('db', 'projects', row.id, { name: 'Distant' });
    await reloadTab();
    // Nouvelle session (onglet rechargé) sur la même copie locale.
    expect((await rows.getProject(row.id))?.data.name).toBe('Local non envoyé');
    const copies = [...mock.col('projects').values()].filter((doc) => doc.$id !== row.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.name).toMatch(/^Distant \(/);
    expect((await idb.idbGetProjectMeta(row.id))?.dirty).toBe(true);
  });

  it('modifications locales plus anciennes que le cloud : elles sont gardées en copie, le cloud est ouvert', async () => {
    const { mock, otherDevice, rows } = await load();
    const row = await rows.createProject('Commun');
    // La copie locale date d'avant l'écriture distante (horloge du faux Appwrite : octobre 2026).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    mock.dbNetworkDown = true;
    await rows.saveProject(row.id, project('Local ancien')).catch(() => undefined);
    mock.dbNetworkDown = false;
    vi.useRealTimers();
    const doc = await otherDevice.getDocument('db', 'projects', row.id);
    await otherDevice.updateDocument('db', 'projects', row.id, { name: 'Distant', data: doc.data });
    await reloadTab();

    expect((await rows.getProject(row.id))?.name).toBe('Distant');
    const copies = [...mock.col('projects').values()].filter((entry) => entry.$id !== row.id);
    expect(copies.map((entry) => entry.name)).toEqual([expect.stringMatching(/^Local ancien \(/)]);
  });

  it('projet partagé : jamais de copie de conflit, la copie locale plus récente sert le temps de la connexion', async () => {
    const { mock, otherDevice, rows, idb } = await load();
    const row = await rows.createProject('Partagé');
    await otherDevice.updateDocument('db', 'projects', row.id, { team_id: `p${row.id}` });
    // Dernier état de la session vu ici, plus récent que le point de sauvegarde du serveur.
    await vi.waitFor(async () => expect(await idb.idbGetProjectMeta(row.id)).not.toBeNull());
    await idb.idbSaveProject({
      ...(await idb.idbGetProjectMeta(row.id))!,
      name: 'État de la session',
      data: project('État de la session'),
      team_id: `p${row.id}`,
      dirty: true,
      updated_at: '2099-01-01T00:00:00.000Z',
    });

    const opened = await rows.getProject(row.id);
    expect(opened?.data.name).toBe('État de la session');
    expect(opened?.dirty).toBe(false);
    expect(mock.col('projects').size).toBe(1);

    // Copie locale plus ancienne que le serveur : la ligne du cloud.
    await idb.idbUpdateProjectMeta(row.id, { updated_at: '2020-01-01T00:00:00.000Z' });
    expect((await rows.getProject(row.id))?.name).toBe('Partagé');
    expect(mock.col('projects').size).toBe(1);
  });

  it('hors ligne : la copie locale est servie', async () => {
    const { mock, rows } = await load();
    const row = await rows.createProject('Local');
    await rows.saveProject(row.id, project('Dernière version'));
    mock.dbNetworkDown = true;
    expect((await rows.getProject(row.id))?.data.name).toBe('Dernière version');
  });
});

describe('listes et suppression', () => {
  it('ignore une ligne lisible par tous qui se dit à moi sans l’être (permissions d’un autre)', async () => {
    const { mock, rows } = await load();
    const mine = await rows.createProject('À moi');
    mock.col('projects').set('piege', {
      $id: 'piege', $createdAt: '2026-10-01T00:00:00Z', $updatedAt: '2026-10-01T00:00:00Z',
      $permissions: ['read("any")', 'update("user:intrus")', 'delete("user:intrus")'],
      user_id: ME, name: 'Piège', data: '', size_bytes: 0, privacy: 'private', folder_id: null,
    });
    expect((await rows.listProjects()).map((summary) => summary.id)).toEqual([mine.id]);
    expect(await rows.getProject('piege')).toBeNull();
  });

  it('supprimer un projet efface sa ligne, sa copie locale et ses fichiers .fit', async () => {
    const { mock, rows, idb } = await load();
    const base = project('Avec FIT');
    const withFit = {
      ...base,
      itineraries: [{
        ...createDefaultItinerary(),
        fitUploads: [{ path: 'fit-1', name: 'sortie.fit', size: 3, type: '', lastModified: 0 }],
      }],
    };
    const row = await rows.createProject('Avec FIT', withFit);
    mock.files.set('fit-1', { bucket: 'itinerary-fit-files', name: 'sortie.fit', bytes: new Uint8Array(3), permissions: [] });
    mock.files.set('fit-autre', { bucket: 'itinerary-fit-files', name: 'autre.fit', bytes: new Uint8Array(3), permissions: [] });

    await rows.deleteProject(row.id);
    expect(mock.col('projects').has(row.id)).toBe(false);
    expect(await idb.idbGetProject(row.id)).toBeNull();
    expect(mock.files.has('fit-1')).toBe(false);
    expect(mock.files.has('fit-autre')).toBe(true);
  });
});
