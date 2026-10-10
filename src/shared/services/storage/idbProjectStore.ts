/**
 * Couche de stockage IndexedDB des projets et du cache de RedView.
 *
 * Élimine définitivement le plafond de 5 Mo de localStorage (QuotaExceededError).
 * Capacité de plusieurs gigaoctets par domaine.
 * Transactionnel, asynchrone, résistant aux plantages.
 */
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import type { ProjectViewState } from '@/features/itineraryPanel/lib/project/layers';
import {
  parseStoredLocalWork,
  parseStoredProject,
  serializeProjectForStorage,
  type SerializedProject,
} from '@/shared/services/projects/storedProject';
import type { ProjectRow, ProjectRowMeta } from '@/shared/services/projects/types';

const DB_NAME = 'redview_storage_v1';
/**
 * v2 : store `views` (vue de l'utilisateur sur chaque projet).
 * v3 : contenu des projets à part (`project_data`), cf. StoredProjectContent.
 */
const DB_VERSION = 3;

const STORE_PROJECTS = 'projects';
const STORE_PROJECT_DATA = 'project_data';
const STORE_CACHE = 'project_cache';
const STORE_THUMBNAILS = 'thumbnails';
const STORE_VIEWS = 'views';

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
      if (!db.objectStoreNames.contains(STORE_PROJECT_DATA)) {
        db.createObjectStore(STORE_PROJECT_DATA, { keyPath: 'id' });
        // Dans la transaction de mise à niveau : tout ou rien.
        if (event.oldVersion > 0 && request.transaction) splitProjectContents(request.transaction);
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'projectId' });
      }
      if (!db.objectStoreNames.contains(STORE_VIEWS)) {
        db.createObjectStore(STORE_VIEWS, { keyPath: 'projectId' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Un autre onglet (ou clearProjectStore) veut supprimer / mettre à niveau
      // la base : on relâche notre poignée pour ne pas bloquer la requête.
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
      // poignée jamais ouverte : rien à fermer
    }
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Les autres onglets sont prévenus par `onversionchange` et ferment leur
      // poignée ; la suppression se termine quand ils l'ont fait.
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
      const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_DATA], 'readwrite');
      const store = tx.objectStore(STORE_PROJECTS);
      const contents = tx.objectStore(STORE_PROJECT_DATA);

      // Jamais par-dessus une ligne existante : la clé héritée n'est pas
      // effacée, et la remettre à chaque chargement écrasait la copie locale
      // à jour (modifications non synchronisées comprises) par une ancienne.
      let imported = 0;
      for (const p of legacyProjects) {
        if (!p?.id) continue;
        const existing = store.getKey(p.id);
        existing.onsuccess = () => {
          if (existing.result !== undefined) return;
          const legacy = p as StoredProjectRow;
          store.put(toMeta(legacy));
          const content = contentOf(legacy);
          if (content) contents.put(content);
          imported += 1;
        };
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      // La clé restant en place, ce passage a lieu à chaque chargement : seul un
      // vrai import est signalé (« Migrated N » s'affichait à chaque fois).
      if (imported > 0) console.info(`[idbProjectStore] Migrated ${imported} projects from localStorage to IndexedDB`);
    }
  } catch (error) {
    console.warn('[idbProjectStore] Migration from localStorage failed (non-fatal)', error);
  }
}

// ── Stockage des projets ──────────────────────────────────────────────────

/**
 * Contenu d'un projet (cf. shared/services/projects/storedProject.ts), dans le
 * store `project_data` : le document partagé en JSON (`data_json`, la charge
 * utile cloud déjà sérialisée par l'autosave) et le travail en attente sur cet
 * appareil (`work_json`). Cloner une chaîne est bien moins coûteux que le
 * clonage structuré d'un graphe d'objets de plusieurs Mo à chaque sauvegarde.
 * Les anciens contenus (projet composé en `data_json`, ou champ `data` objet)
 * restent lisibles.
 *
 * Les métadonnées (store `projects`) sont à part depuis la v3 : les relire ou
 * les réécrire (version cloud de base, `dirty`, nom, liste des projets) clonait
 * le document entier — un projet de 61 M car. deux fois par sauvegarde, et la
 * liste désérialisait tous les contenus.
 */
type StoredProjectContent = { id: string; data?: ItineraryProject; data_json?: string; work_json?: string };

/** Ligne du store `projects` : métadonnées (le contenu y était avant la v3). */
type StoredProjectRow = ProjectRowMeta & Omit<StoredProjectContent, 'id'>;

function toMeta(stored: StoredProjectRow): ProjectRowMeta {
  const meta: Partial<StoredProjectRow> = { ...stored };
  delete meta.data;
  delete meta.data_json;
  delete meta.work_json;
  return meta as ProjectRowMeta;
}

/** Contenu porté par une ligne antérieure à la v3 (null s'il n'y en a pas). */
function contentOf(stored: StoredProjectRow): StoredProjectContent | null {
  if (stored.data === undefined && stored.data_json === undefined && stored.work_json === undefined) return null;
  const content: StoredProjectContent = { id: stored.id };
  if (stored.data !== undefined) content.data = stored.data;
  if (stored.data_json !== undefined) content.data_json = stored.data_json;
  if (stored.work_json !== undefined) content.work_json = stored.work_json;
  return content;
}

/** Mise à niveau v3 : sort le contenu de chaque ligne vers `project_data`. */
function splitProjectContents(tx: IDBTransaction): void {
  const contents = tx.objectStore(STORE_PROJECT_DATA);
  const cursorRequest = tx.objectStore(STORE_PROJECTS).openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const stored = cursor.value as StoredProjectRow;
    const content = contentOf(stored);
    if (content) {
      contents.put(content);
      cursor.update(toMeta(stored));
    }
    cursor.continue();
  };
}

function hydrate(stored: StoredProjectRow | undefined | null, content: StoredProjectContent | undefined | null): ProjectRow | null {
  if (!stored) return null;
  const source = content ?? stored;
  let raw: unknown = source.data;
  if (typeof source.data_json === 'string') {
    try {
      raw = JSON.parse(source.data_json);
    } catch (error) {
      console.warn('[idbProjectStore] corrupted project JSON', stored.id, error);
      raw = undefined;
    }
  }
  const parsed = raw === undefined ? null : parseStoredProject(raw, parseStoredLocalWork(source.work_json));
  if (!parsed) return null;
  return { ...toMeta(stored), data: parsed.project };
}

function sortByUpdatedDesc<T extends { updated_at: string }>(list: T[]): T[] {
  return list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/**
 * Écrit une ligne projet. `serialized` : document et travail local déjà
 * sérialisés par l'appelant (sinon calculés ici depuis `row.data`). Résout une
 * fois la transaction validée (donnée durable), pas seulement la requête acceptée.
 */
export async function idbSaveProject(row: ProjectRow, serialized?: SerializedProject): Promise<void> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  const { data, ...meta } = row;
  const { documentJson, workJson } = serialized ?? serializeProjectForStorage(data);
  const content: StoredProjectContent = { id: row.id, data_json: documentJson };
  if (workJson) content.work_json = workJson;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_DATA], 'readwrite');
    tx.objectStore(STORE_PROJECTS).put(meta);
    tx.objectStore(STORE_PROJECT_DATA).put(content);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGetProject(id: string): Promise<ProjectRow | null> {
  await migrateFromLocalStorageIfNeeded();
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_DATA], 'readonly');
    const metaRequest = tx.objectStore(STORE_PROJECTS).get(id);
    const contentRequest = tx.objectStore(STORE_PROJECT_DATA).get(id);
    tx.oncomplete = () => {
      try {
        resolve(hydrate(
          metaRequest.result as StoredProjectRow | undefined,
          contentRequest.result as StoredProjectContent | undefined,
        ));
      } catch (error) {
        reject(error);
      }
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
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
    const tx = db.transaction([STORE_PROJECTS, STORE_PROJECT_DATA, STORE_CACHE, STORE_THUMBNAILS, STORE_VIEWS], 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(id);
    tx.objectStore(STORE_PROJECT_DATA).delete(id);
    tx.objectStore(STORE_CACHE).delete(id);
    tx.objectStore(STORE_THUMBNAILS).delete(id);
    tx.objectStore(STORE_VIEWS).delete(id);
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

// ── Stockage des miniatures (miniatures locales) ───────────────────────────

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

// ── Vues (couche « vue » de chaque projet, cf. projectViews.ts) ────────────

export interface IdbProjectViewEntry {
  projectId: string;
  /** Utilisateur dont c'est la vue (copie scopée par compte). */
  ownerId: string;
  /** Horodatage ISO de la modification (dernière écriture gagnante). */
  updatedAt: string;
  view: ProjectViewState;
}

export async function idbGetProjectView(projectId: string): Promise<IdbProjectViewEntry | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_VIEWS], 'readonly');
    const req = tx.objectStore(STORE_VIEWS).get(projectId);
    req.onsuccess = () => resolve((req.result as IdbProjectViewEntry | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSaveProjectView(entry: IdbProjectViewEntry): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_VIEWS], 'readwrite');
    tx.objectStore(STORE_VIEWS).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbDeleteProjectView(projectId: string): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_VIEWS], 'readwrite');
    tx.objectStore(STORE_VIEWS).delete(projectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
