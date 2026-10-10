import { BATCH_FORMAT_PROTOCOLS } from '../protocol';
import type { UnsyncedBatch } from './syncEngine';

/**
 * Modifications de co-édition que le serveur n'a peut-être pas encore
 * écrites, gardées sur l'appareil (IndexedDB `redview-collab`) : un onglet
 * fermé hors ligne, ou avant l'écriture du journal, ne les perd pas. Une
 * copie par client (onglet) : la session suivante du même utilisateur sur ce
 * projet les adopte toutes, chacune avec son `clientId` (session.ts), et le
 * serveur, qui connaît le dernier lot appliqué de chaque client
 * (`welcome.clientSeq`), n'en applique jamais un deux fois.
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
  /** Version du protocole des lots (relus seulement si leur format est l'actuel : `BATCH_FORMAT_PROTOCOLS`). */
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

/**
 * Compte supprimé : ses copies partent, jamais celles d'un autre compte du
 * même appareil (non envoyées : ce serait son travail perdu, B3-3).
 */
export async function deleteUnsyncedOfUser(userId: string): Promise<void> {
  // L'ouvrir créerait la base sur un appareil qui ne l'a jamais eue.
  const known = await indexedDB.databases?.().catch(() => null);
  if (known && !known.some((database) => database.name === DB_NAME)) return;
  const records = await run('readonly', (store) => store.getAll() as IDBRequest<UnsyncedRecord[]>);
  for (const record of records) {
    if (record.userId === userId) await deleteUnsynced(record.clientId);
  }
  // Plus rien d'un autre compte : la base entière part, comme avant.
  if (records.every((record) => record.userId === userId)) await dropDatabase();
}

async function dropDatabase(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  (await pending?.catch(() => null))?.close();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
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

export interface AdoptedUnsynced {
  record: UnsyncedRecord;
  release: () => void;
}

/**
 * TOUTES les copies laissées par des onglets fermés pour ce projet et cet
 * utilisateur, chacune verrouillée pour cette session, la plus ancienne
 * d'abord ; les copies trop vieilles, vides ou d'un autre format de lots sont
 * supprimées au passage. Les reprendre toutes d'un coup (et non une par
 * session) : une copie laissée en attente serait rejouée des jours plus tard
 * par-dessus des modifications plus récentes (C1-1).
 */
export async function adoptAllUnsynced(projectId: string, userId: string): Promise<AdoptedUnsynced[]> {
  const records = (await listUnsynced(projectId))
    .filter((record) => record.userId === userId)
    .sort((a, b) => a.savedAt - b.savedAt);
  const adopted: AdoptedUnsynced[] = [];
  for (const record of records) {
    const release = await holdClientLock(record.clientId);
    if (!release) continue;
    const usable = BATCH_FORMAT_PROTOCOLS.includes(record.protocol)
      && record.batches.length > 0
      && Date.now() - record.savedAt <= MAX_AGE_MS;
    if (usable) {
      adopted.push({ record, release });
      continue;
    }
    await deleteUnsynced(record.clientId).catch(() => undefined);
    release();
  }
  return adopted;
}
