import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { serializeProjectForStorage } from '@/shared/services/projects/storedProject';
import type { ProjectRow, ProjectRowMeta } from '@/shared/services/projects/types';

const DB_NAME = 'redview_storage_v1';

function meta(id: string, extra: Partial<ProjectRowMeta> = {}): ProjectRowMeta {
  return {
    id,
    user_id: 'u1',
    folder_id: null,
    name: `Projet ${id}`,
    size_bytes: 10,
    privacy: 'private',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    dirty: false,
    cloud_updated_at: null,
    team_id: null,
    ...extra,
  };
}

function project(name: string) {
  return { ...createDefaultProject(), name };
}

/** JSON du document d'un projet : égalité de contenu après un aller-retour. */
const documentOf = (row: ProjectRow | null) => (row ? serializeProjectForStorage(row.data).documentJson : null);

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function openRaw(version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, version);
  if (upgrade) req.onupgradeneeded = () => upgrade(req.result);
  return request(req);
}

async function readAll(db: IDBDatabase, store: string): Promise<Array<Record<string, unknown>>> {
  return request(db.transaction([store], 'readonly').objectStore(store).getAll());
}

async function loadStore() {
  vi.resetModules();
  return import('./idbProjectStore');
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const local = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => { local.set(key, value); },
      removeItem: (key: string) => { local.delete(key); },
    },
  });
});

describe('idbProjectStore', () => {
  it('keeps metadata and content apart: meta reads and writes never carry the document', async () => {
    const store = await loadStore();
    const row: ProjectRow = { ...meta('p1', { dirty: true }), data: project('Ultra') };
    await store.idbSaveProject(row);

    expect(documentOf(await store.idbGetProject('p1'))).toBe(documentOf(row));
    expect(await store.idbGetProjectMeta('p1')).toEqual(meta('p1', { dirty: true }));
    expect(await store.idbListProjectMetas()).toEqual([meta('p1', { dirty: true })]);

    expect(await store.idbUpdateProjectMeta('p1', (current) => ({ dirty: !current.dirty, cloud_updated_at: 'v2' }))).toBe(true);
    const updated = await store.idbGetProject('p1');
    expect(updated?.dirty).toBe(false);
    expect(updated?.cloud_updated_at).toBe('v2');
    expect(documentOf(updated)).toBe(documentOf(row));

    const db = await openRaw(3);
    const [metaRecord] = await readAll(db, 'projects');
    expect(Object.keys(metaRecord ?? {}).sort()).toEqual(Object.keys(meta('p1')).sort());
    const [content] = await readAll(db, 'project_data');
    expect(content?.id).toBe('p1');
    expect(typeof content?.data_json).toBe('string');
    db.close();
  });

  it('replaces the stored content on save (no stale local work) and deletes both parts', async () => {
    const store = await loadStore();
    const first = project('A');
    await store.idbSaveProject({ ...meta('p1'), data: first }, { documentJson: serializeProjectForStorage(first).documentJson, workJson: '{"x":1}' });
    const second = project('B');
    await store.idbSaveProject({ ...meta('p1'), data: second });
    const db = await openRaw(3);
    const [content] = await readAll(db, 'project_data');
    expect(content?.work_json).toBeUndefined();
    db.close();
    expect((await store.idbGetProject('p1'))?.data.name).toBe('B');

    await store.idbDeleteProject('p1');
    expect(await store.idbGetProject('p1')).toBeNull();
    const after = await openRaw(3);
    expect(await readAll(after, 'project_data')).toEqual([]);
    after.close();
  });

  it('moves the content of v2 rows out of the metadata on upgrade, nothing lost', async () => {
    const jsonProject = project('Stocké en JSON');
    const objectProject = project('Stocké en objet');
    const v2 = await openRaw(2, (db) => {
      for (const name of ['projects']) db.createObjectStore(name, { keyPath: 'id' });
      for (const name of ['project_cache', 'thumbnails', 'views']) db.createObjectStore(name, { keyPath: 'projectId' });
    });
    const tx = v2.transaction(['projects'], 'readwrite');
    tx.objectStore('projects').put({ ...meta('json', { dirty: true }), data_json: serializeProjectForStorage(jsonProject).documentJson, work_json: '{}' });
    tx.objectStore('projects').put({ ...meta('object'), data: objectProject });
    tx.objectStore('projects').put(meta('empty'));
    await new Promise((resolve) => { tx.oncomplete = resolve; });
    v2.close();

    const store = await loadStore();
    expect(documentOf(await store.idbGetProject('json'))).toBe(serializeProjectForStorage(jsonProject).documentJson);
    expect((await store.idbGetProject('json'))?.dirty).toBe(true);
    expect(documentOf(await store.idbGetProject('object'))).toBe(serializeProjectForStorage(objectProject).documentJson);
    expect(await store.idbGetProject('empty')).toBeNull();
    expect((await store.idbListProjectMetas()).map((row) => row.id).sort()).toEqual(['empty', 'json', 'object']);

    const db = await openRaw(3);
    for (const record of await readAll(db, 'projects')) {
      expect(record).not.toHaveProperty('data');
      expect(record).not.toHaveProperty('data_json');
      expect(record).not.toHaveProperty('work_json');
    }
    const contents = await readAll(db, 'project_data');
    expect(contents.map((content) => content.id).sort()).toEqual(['json', 'object']);
    expect(contents.find((content) => content.id === 'json')?.work_json).toBe('{}');
    db.close();
  });

  it('imports legacy localStorage projects split like the others, never over an existing row', async () => {
    const legacy = project('Ancien localStorage');
    window.localStorage.setItem('redview:local-projects:v1', JSON.stringify([
      { ...meta('legacy'), data: legacy },
      { ...meta('kept'), data: project('Ancienne version') },
    ]));
    const kept = project('Version à jour');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const first = await loadStore();
    await first.idbSaveProject({ ...meta('kept'), data: kept });
    expect(info).toHaveBeenCalledWith('[idbProjectStore] Migrated 2 projects from localStorage to IndexedDB');

    info.mockClear();
    const store = await loadStore();
    expect(documentOf(await store.idbGetProject('legacy'))).toBe(serializeProjectForStorage(legacy).documentJson);
    expect((await store.idbGetProject('kept'))?.data.name).toBe('Version à jour');
    expect(await store.idbGetProjectMeta('legacy')).toEqual(meta('legacy'));
    // La clé héritée reste : le passage suivant n'importe rien et ne le dit pas.
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('deleting a project also deletes its thumbnail and view', async () => {
    const store = await loadStore();
    await store.idbSaveProject({ ...meta('p1'), data: project('A') });
    await store.idbSaveProject({ ...meta('p2'), data: project('B') });
    await store.idbSaveThumbnail('p1', new Blob(['png']));
    await store.idbSaveThumbnail('p2', new Blob(['png']));
    await store.idbSaveProjectView({ projectId: 'p1', ownerId: 'u1', updatedAt: '2026-10-01T00:00:00.000Z', view: { itineraries: {} } });

    await store.idbDeleteProject('p1');
    expect(await store.idbGetThumbnail('p1')).toBeNull();
    expect(await store.idbGetProjectView('p1')).toBeNull();
    expect(await store.idbGetThumbnail('p2')).not.toBeNull();
    expect(await store.idbGetProject('p2')).not.toBeNull();
  });

  it('a meta update on a missing project writes nothing', async () => {
    const store = await loadStore();
    expect(await store.idbUpdateProjectMeta('absent', { dirty: true })).toBe(false);
    expect(await store.idbListProjectMetas()).toEqual([]);
  });

  it('sign-out on a shared device keeps only the unsynced copies of another account (B3-3)', async () => {
    const store = await loadStore();
    await store.idbSaveProject({ ...meta('a-dirty', { user_id: 'alice', dirty: true }), data: project('Alice hors ligne') });
    await store.idbSaveProject({ ...meta('a-clean', { user_id: 'alice' }), data: project('Alice synchro') });
    await store.idbSaveProject({ ...meta('b-dirty', { user_id: 'bob', dirty: true }), data: project('Bob hors ligne') });
    await store.idbSaveThumbnail('a-dirty', new Blob(['png']));
    await store.idbSaveThumbnail('b-dirty', new Blob(['png']));
    await store.idbSaveProjectView({ projectId: 'b-dirty', ownerId: 'bob', updatedAt: '2026-10-01T00:00:00.000Z', view: { itineraries: {} } });

    await store.clearProjectStoreForUser('bob');
    expect(documentOf(await store.idbGetProject('a-dirty'))).toBe(documentOf({ ...meta('a'), data: project('Alice hors ligne') }));
    expect(await store.idbGetThumbnail('a-dirty')).not.toBeNull();
    expect(await store.idbGetProject('a-clean')).toBeNull();
    expect(await store.idbGetProject('b-dirty')).toBeNull();
    expect(await store.idbGetThumbnail('b-dirty')).toBeNull();
    expect(await store.idbGetProjectView('b-dirty')).toBeNull();

    // Nothing of another account left to keep: the whole database goes, as before.
    await store.clearProjectStoreForUser('alice');
    expect(await store.idbListProjectMetas()).toEqual([]);
  });

  it('sign-out wipes everything, even while another tab holds the database open', async () => {
    const otherTab = await loadStore();
    await otherTab.idbSaveProject({ ...meta('p1'), data: project('A') });
    await otherTab.idbSaveThumbnail('p1', new Blob(['png']));
    const store = await loadStore();
    expect(await store.idbGetProject('p1')).not.toBeNull();

    await store.clearProjectStore();
    expect(await store.idbGetProject('p1')).toBeNull();
    expect(await store.idbGetThumbnail('p1')).toBeNull();
    // The other tab released its handle and reopens a fresh database.
    expect(await otherTab.idbListProjectMetas()).toEqual([]);
  });
});
