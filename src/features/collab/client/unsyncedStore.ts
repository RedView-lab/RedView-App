import { PROTOCOL_VERSION } from '../protocol';
import type { UnsyncedBatch } from './syncEngine';

/**
 * Modifications de co-édition que le serveur n'a peut-être pas encore
 * écrites, gardées sur l'appareil (IndexedDB `redview-collab`) : un onglet
 * fermé hors ligne, ou avant l'écriture du journal, ne les perd pas. Une
 * copie par client (onglet) : la session suivante du même utilisateur sur ce
 * projet l'adopte avec son `clientId`, et le serveur, qui connaît le dernier
 * lot appliqué de chaque client (`welcome.clientSeq`), n'en applique jamais
 * un deux fois.
 *
 * Un verrou Web Locks par client, tenu toute la session : une copie dont le
 * verrou est libre appartient à un onglet fermé (ou à une session terminée)
 * et ne peut être adoptée que par un seul onglet. Sans Web Locks ni
 * IndexedDB, rien n'est gardé : deux onglets ne doivent jamais partager un
 * client.
 */

export interface UnsyncedRecord {
  clientId: string;
  projectId: string;
  userId: string;
  /** Version du protocole des lots (une autre version ne les relit pas). */
  protocol: number;
  nextClientSeq: number;
  batches: UnsyncedBatch[];
  savedAt: number;
}

const DB_NAME = 'redview-collab';
const DB_VERSION = 1;
const STORE = 'unsynced';
const PROJECT_INDEX = 'projectId';
const LOCK_PREFIX = 'redview:collab-client:';
/** Copie jamais reprise : abandonnée au-delà. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

export function unsyncedPersistenceSupported(): boolean {
  return typeof indexedDB !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.locks;
}

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'clientId' });
      store.createIndex(PROJECT_INDEX, 'projectId');
    };
    request.onsuccess = () => {
      const db = request.result;
      // Une autre version de la base ouverte ailleurs : on la libère.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB indisponible'));
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('transaction IndexedDB annulée'));
  });
}

export function writeUnsynced(record: UnsyncedRecord): Promise<void> {
  return run('readwrite', (store) => store.put(record)).then(() => undefined);
}

export function deleteUnsynced(clientId: string): Promise<void> {
  return run('readwrite', (store) => store.delete(clientId)).then(() => undefined);
}

function listUnsynced(projectId: string): Promise<UnsyncedRecord[]> {
  return run('readonly', (store) => store.index(PROJECT_INDEX).getAll(projectId) as IDBRequest<UnsyncedRecord[]>);
}

/**
 * Tient le verrou du client s'il est libre, jusqu'à l'appel de la fonction
 * renvoyée ; null : un autre onglet le tient.
 */
export function holdClientLock(clientId: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    navigator.locks
      .request(`${LOCK_PREFIX}${clientId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(() => resolve(null));
  });
}

/**
 * Copie laissée par un onglet fermé (le plus ancien d'abord) pour ce projet
 * et cet utilisateur, verrouillée pour cette session ; les copies trop
 * vieilles, vides ou d'un autre protocole sont supprimées au passage.
 */
export async function adoptUnsynced(
  projectId: string,
  userId: string,
): Promise<{ record: UnsyncedRecord; release: () => void } | null> {
  const records = (await listUnsynced(projectId))
    .filter((record) => record.userId === userId)
    .sort((a, b) => a.savedAt - b.savedAt);
  for (const record of records) {
    const release = await holdClientLock(record.clientId);
    if (!release) continue;
    const usable = record.protocol === PROTOCOL_VERSION
      && record.batches.length > 0
      && Date.now() - record.savedAt <= MAX_AGE_MS;
    if (usable) return { record, release };
    await deleteUnsynced(record.clientId).catch(() => undefined);
    release();
  }
  return null;
}
