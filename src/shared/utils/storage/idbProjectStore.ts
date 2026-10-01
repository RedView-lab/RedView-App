/**
 * IndexedDB Storage Layer for RedView Projects & Cache.
 *
 * Élimine définitivement le plafond de 5 Mo de localStorage (QuotaExceededError).
 * Capacité de plusieurs gigaoctets par domaine.
 * Transactionnel, asynchrone, crash-proof.
 */
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import type { ProjectRow, ProjectRowMeta } from '@/shared/utils/projects/types';

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
      const db = request.result;
      // Another tab (or clearProjectStore) wants to delete/upgrade the DB:
      // release our handle so the request is not blocked.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
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

/**
 * Supprime entièrement la base IndexedDB (projets, caches, miniatures).
 * Appelé à la déconnexion : ces données sont propres à l'utilisateur.
 */
export async function clearProjectStore(): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;

  const pending = dbPromise;
  dbPromise = null;
  migrationDone = false;
  if (pending) {
    try {
      (await pending).close();
    } catch {
      // handle never opened: nothing to close
    }
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Other tabs are notified through `onversionchange` and close their handle;
      // the deletion completes once they do.
      console.warn('[idbProjectStore] IndexedDB delete blocked by other tabs');
    };
  });
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

/**
 * Forme stockée : le contenu du projet est conservé en JSON (`data_json`), déjà
 * sérialisé par l'autosave. Cloner une chaîne est bien moins coûteux que le
 * clonage structuré d'un graphe d'objets de plusieurs Mo à chaque sauvegarde.
 * Les anciennes lignes (champ `data` objet) restent lisibles.
 */
type StoredProjectRow = ProjectRowMeta & { data?: ItineraryProject; data_json?: string };

function toMeta(stored: StoredProjectRow): ProjectRowMeta {
  const meta: Partial<StoredProjectRow> = { ...stored };
  delete meta.data;
  delete meta.data_json;
  return meta as ProjectRowMeta;
}

function hydrate(stored: StoredProjectRow | undefined | null): ProjectRow | null {
  if (!stored) return null;
  let data: ItineraryProject | undefined = stored.data;
  if (typeof stored.data_json === 'string') {
    try {
      data = JSON.parse(stored.data_json) as ItineraryProject;
    } catch (error) {
      console.warn('[idbProjectStore] corrupted project JSON', stored.id, error);
      data = undefined;
    }
  }
  if (!data) return null;
  return { ...toMeta(stored), data };
}

function sortByUpdatedDesc<T extends { updated_at: string }>(list: T[]): T[] {
  return list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/**
 * Écrit une ligne projet. `serializedData` : JSON de `row.data` déjà calculé par
 * l'appelant (sinon sérialisé ici). Résout une fois la transaction validée
 * (donnée durable), pas seulement la requête acceptée.
 */
export async function idbSaveProject(row: ProjectRow, serializedData?: string): Promise<void> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  const { data, ...meta } = row;
  const stored: StoredProjectRow = { ...meta, data_json: serializedData ?? JSON.stringify(data) };
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readwrite');
    tx.objectStore(STORE_PROJECTS).put(stored);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGetProject(id: string): Promise<ProjectRow | null> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.get(id);
    req.onsuccess = () => resolve(hydrate(req.result as StoredProjectRow | undefined));
    req.onerror = () => reject(req.error);
  });
}

/** Métadonnées d'une ligne (sans désérialiser le contenu du projet). */
export async function idbGetProjectMeta(id: string): Promise<ProjectRowMeta | null> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).get(id);
    req.onsuccess = () => {
      const stored = req.result as StoredProjectRow | undefined;
      resolve(stored ? toMeta(stored) : null);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Met à jour les métadonnées d'une ligne existante dans une seule transaction
 * (lecture + écriture), sans toucher au contenu. Renvoie false si la ligne
 * n'existe pas.
 */
export async function idbUpdateProjectMeta(
  id: string,
  patch: Partial<Omit<ProjectRowMeta, 'id'>> | ((meta: ProjectRowMeta) => Partial<Omit<ProjectRowMeta, 'id'>>),
): Promise<boolean> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.get(id);
    let found = false;
    req.onsuccess = () => {
      const stored = req.result as StoredProjectRow | undefined;
      if (!stored) return;
      found = true;
      const next = typeof patch === 'function' ? patch(toMeta(stored)) : patch;
      store.put({ ...stored, ...next, id });
    };
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
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
      const list = ((req.result || []) as StoredProjectRow[])
        .map((stored) => hydrate(stored))
        .filter((row): row is ProjectRow => row !== null);
      resolve(sortByUpdatedDesc(list));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Liste les métadonnées des lignes (sans désérialiser les contenus). */
export async function idbListProjectMetas(): Promise<ProjectRowMeta[]> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS], 'readonly');
    const req = tx.objectStore(STORE_PROJECTS).getAll();
    req.onsuccess = () => {
      resolve(sortByUpdatedDesc(((req.result || []) as StoredProjectRow[]).map(toMeta)));
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
  /** Identifiant de l'utilisateur propriétaire du snapshot (cache scopé par compte). */
  ownerId?: string;
  cachedAt: string;
  project: ItineraryProject;
}

export async function idbSaveProjectCache(
  projectId: string,
  project: ItineraryProject,
  ownerId: string,
): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_CACHE], 'readwrite');
    const store = tx.objectStore(STORE_CACHE);
    // IndexedDB copie déjà la valeur (clonage structuré) : pas de copie en plus.
    const entry: IdbCacheEntry = {
      projectId,
      ownerId,
      cachedAt: new Date().toISOString(),
      project,
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
