/**
 * IndexedDB Storage Layer for RedView Projects & Cache.
 *
 * Élimine définitivement le plafond de 5 Mo de localStorage (QuotaExceededError).
 * Capacité de plusieurs gigaoctets par domaine.
 * Transactionnel, asynchrone, crash-proof.
 */
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import type { ProjectRow } from '@/shared/utils/projects/types';

const DB_NAME = 'redview_storage_v1';
const DB_VERSION = 1;

const STORE_PROJECTS = 'projects';
const STORE_CACHE = 'project_cache';
const STORE_THUMBNAILS = 'thumbnails';

let dbPromise: Promise<IDBDatabase> | null = null;
let migrationDone = false;

function getDb(): Promise<IDBDatabase> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available in this environment'));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'projectId' });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };

    request.onblocked = () => {
      console.warn('[idbProjectStore] IndexedDB open blocked by other tabs');
    };
  });

  return dbPromise;
}

// ── Migration depuis LocalStorage ─────────────────────────────────────────

const LOCAL_PROJECTS_KEY = 'redview:local-projects:v1';

export async function migrateFromLocalStorageIfNeeded(): Promise<void> {
  if (migrationDone || typeof window === 'undefined') return;
  migrationDone = true;

  try {
    const raw = window.localStorage.getItem(LOCAL_PROJECTS_KEY);
    if (!raw) return;

    const legacyProjects = JSON.parse(raw) as ProjectRow[];
    if (Array.isArray(legacyProjects) && legacyProjects.length > 0) {
      const db = await getDb();
      const tx = db.transaction([STORE_PROJECTS], 'readwrite');
      const store = tx.objectStore(STORE_PROJECTS);

      for (const p of legacyProjects) {
        if (p?.id) {
          store.put(p);
        }
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      console.info(`[idbProjectStore] Migrated ${legacyProjects.length} projects from localStorage to IndexedDB`);
    }
  } catch (error) {
    console.warn('[idbProjectStore] Migration from localStorage failed (non-fatal)', error);
  }
}

// ── Projects Store ────────────────────────────────────────────────────────

export async function idbSaveProject(row: ProjectRow): Promise<void> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetProject(id: string): Promise<ProjectRow | null> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbListProjects(): Promise<ProjectRow[]> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.getAll();
    req.onsuccess = () => {
      const list = (req.result || []) as ProjectRow[];
      // Tri par date de mise à jour descendante
      list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function idbDeleteProject(id: string): Promise<void> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_CACHE, STORE_THUMBNAILS], 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(id);
    tx.objectStore(STORE_CACHE).delete(id);
    tx.objectStore(STORE_THUMBNAILS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Cache de Projet Actif (Snapshot complet crash-proof) ──────────────────

export interface IdbCacheEntry {
  projectId: string;
  cachedAt: string;
  project: ItineraryProject;
}

export async function idbSaveProjectCache(projectId: string, project: ItineraryProject): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CACHE], 'readwrite');
    const store = tx.objectStore(STORE_CACHE);
    const entry: IdbCacheEntry = {
      projectId,
      cachedAt: new Date().toISOString(),
      project: structuredClone(project),
    };
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetProjectCache(projectId: string): Promise<IdbCacheEntry | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CACHE], 'readonly');
    const store = tx.objectStore(STORE_CACHE);
    const req = store.get(projectId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ── Thumbnails Store (Miniatures locales) ──────────────────────────────────

export async function idbSaveThumbnail(projectId: string, blob: Blob): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_THUMBNAILS], 'readwrite');
    const store = tx.objectStore(STORE_THUMBNAILS);
    const req = store.put({ projectId, blob, updatedAt: new Date().toISOString() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGetThumbnail(projectId: string): Promise<Blob | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_THUMBNAILS], 'readonly');
    const store = tx.objectStore(STORE_THUMBNAILS);
    const req = store.get(projectId);
    req.onsuccess = () => {
      const res = req.result;
      resolve(res?.blob || null);
    };
    req.onerror = () => reject(req.error);
  });
}
