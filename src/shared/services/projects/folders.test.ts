import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadProjectPersistence } from '@/shared/test/projectPersistence';

/**
 * Dossiers (folders.ts) sur le vrai code : faux SDK Appwrite en mémoire du
 * banc de persistance, vraie copie IndexedDB (fake-indexeddb).
 */

vi.mock('appwrite', () => import('@/shared/test/mockAppwriteSdk'));

async function load() {
  return { ...(await loadProjectPersistence('user-A')), folders: await import('./folders') };
}

beforeAll(async () => {
  await load();
}, 60_000);

describe('moveProjectFolder', () => {
  it('refuse un dossier dans l’un de ses sous-dossiers, même depuis une liste périmée (D3-1)', async () => {
    const { mock, folders } = await load();
    const a = await folders.createProjectFolder('A');
    const b = await folders.createProjectFolder('B');
    // Onglet 1 : A dans B. Onglet 2, liste pas encore rafraîchie : B dans A.
    await folders.moveProjectFolder(a.id, b.id);
    await expect(folders.moveProjectFolder(b.id, a.id)).rejects.toSatisfy((error) => (error as { kind?: string }).kind === 'rejected');
    expect(mock.col('project_folders').get(b.id)?.parent_folder_id ?? null).toBeNull();
    expect(mock.col('project_folders').get(a.id)?.parent_folder_id).toBe(b.id);

    // Un dossier lui-même : rien à faire.
    await folders.moveProjectFolder(a.id, a.id);
    expect(mock.col('project_folders').get(a.id)?.parent_folder_id).toBe(b.id);
  });
});
