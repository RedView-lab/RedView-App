import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { vi } from 'vitest';

/**
 * Persistance des projets sous Vitest : le vrai code de
 * shared/services/projects sur le faux SDK Appwrite en mémoire du banc de
 * persistance (mockAppwriteSdk.ts, aussi celui du banc a-persistence-sim) et une vraie
 * IndexedDB (fake-indexeddb), session de `userId` ouverte.
 *
 * Le fichier de test déclare lui-même le remplacement du SDK (vi.mock est
 * remonté en tête de fichier) :
 *
 *   vi.mock('appwrite', () => import('@/shared/test/mockAppwriteSdk'));
 *
 * Chaque appel repart d'un état vide (modules rechargés, IndexedDB neuve).
 */
export type MockAppwriteSdk = typeof import('./mockAppwriteSdk');

export async function loadProjectPersistence(userId = 'user-A') {
  vi.resetModules();
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
  const sdk = (await import('appwrite')) as unknown as MockAppwriteSdk;
  sdk.__mock.reset();
  sdk.__mock.user = { $id: userId, email: `${userId}@example.test`, name: userId, prefs: {} };
  (await import('@/shared/services/appwrite')).saveStoredAppwriteSession({ id: userId });
  return {
    mock: sdk.__mock,
    /** Écritures d'un autre appareil, directement dans le faux Appwrite. */
    otherDevice: new sdk.Databases(),
    idb: await import('@/shared/services/storage/idbProjectStore'),
  };
}

/** Onglet rechargé : l'état de session en mémoire est perdu, la copie locale reste. */
export async function reloadProjectSession(): Promise<void> {
  const session = await import('@/shared/services/projects/projectSession');
  session.knownCloudVersions.clear();
  session.confirmedDocuments.clear();
  session.localRevisions.clear();
}
