import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Effacement des fichiers FIT (traces GPS, fréquence cardiaque : RGPD) :
 * ceux d'un projet sont retrouvés dans son document, ceux d'un itinéraire
 * supprimé attendent la fermeture du projet pour qu'une annulation reste
 * possible.
 */

const bucket = vi.hoisted(() => ({
  deleted: [] as string[],
  missing: new Set<string>(),
  /** Fichiers lisibles par le compte (les siens et ceux des projets partagés avec lui). */
  listed: [] as Array<{ $id: string; $permissions: string[] }>,
}));

vi.mock('@/shared/services/appwrite', () => ({
  FIT_FILES_BUCKET_ID: 'fit-files',
  ID: { unique: () => 'id' },
  Permission: {},
  Query: { limit: (n: number) => `limit(${n})`, cursorAfter: (id: string) => `cursorAfter(${id})` },
  Role: {},
  client: {},
  storage: {
    async listFiles(bucketId: string, queries: string[]) {
      expect(bucketId).toBe('fit-files');
      const after = queries.find((query) => query.startsWith('cursorAfter('))?.slice('cursorAfter('.length, -1);
      const start = after ? bucket.listed.findIndex((file) => file.$id === after) + 1 : 0;
      return { files: bucket.listed.slice(start, start + 100) };
    },
    async deleteFile(bucketId: string, fileId: string) {
      expect(bucketId).toBe('fit-files');
      if (bucket.missing.has(fileId)) throw Object.assign(new Error('absent'), { code: 404 });
      bucket.deleted.push(fileId);
    },
  },
}));
vi.mock('./auth', () => ({ getCurrentUserId: async () => 'moi' }));
vi.mock('./liveSessions', () => ({ isLiveSession: () => false, sharedProjectTeamId: () => null }));

const { collectProjectFitUploads, deleteOwnedFitFiles, flushPendingFitDeletions, isFitFileOwnedBy, scheduleFitUploadsDeletion } = await import('./fitFiles');

const upload = (path: string | null, name = `${path}.fit`) => ({ path, name, size: 1, type: '', lastModified: 0 });
const project = (...itineraries: Array<Array<ReturnType<typeof upload>>>) => ({
  itineraries: itineraries.map((fitUploads, index) => ({ id: `it${index}`, fitUploads })),
});

beforeEach(() => {
  bucket.deleted = [];
  bucket.missing.clear();
  bucket.listed = [];
});

describe('retrait du consentement : fichiers FIT du compte', () => {
  const owned = (id: string) => ({ $id: id, $permissions: ['read("user:moi")', 'update("user:moi")', 'delete("user:moi")'] });
  const sharedByOther = (id: string) => ({ $id: id, $permissions: ['read("user:autre")', 'update("user:autre")', 'delete("user:autre")', 'read("team:p1")'] });

  it('reconnaît le propriétaire par ses permissions, jamais par la seule lecture', () => {
    expect(isFitFileOwnedBy(owned('a').$permissions, 'moi')).toBe(true);
    expect(isFitFileOwnedBy(sharedByOther('b').$permissions, 'moi')).toBe(false);
    expect(isFitFileOwnedBy(['read("user:moi")'], 'moi')).toBe(false);
    expect(isFitFileOwnedBy(undefined, 'moi')).toBe(false);
  });

  it('efface tous les fichiers du compte, orphelins compris, sur plusieurs pages, sans toucher à ceux des autres', async () => {
    bucket.listed = [
      ...Array.from({ length: 150 }, (_, i) => owned(`mien-${i}`)),
      sharedByOther('partage-1'),
      owned('mien-absent'),
    ];
    bucket.missing.add('mien-absent');
    const result = await deleteOwnedFitFiles();
    expect(result).toEqual({ deleted: 151, failed: 0 });
    expect(bucket.deleted).toHaveLength(150);
    expect(bucket.deleted).not.toContain('partage-1');
  });
});

describe('collectProjectFitUploads', () => {
  it('liste les fichiers du bucket de tous les itinéraires, sans les anciens fichiers en base64', () => {
    const uploads = collectProjectFitUploads(project([upload('a'), upload(null)], [], [upload('b')]) as never);
    expect(uploads.map((u) => u.path)).toEqual(['a', 'b']);
    expect(collectProjectFitUploads(null)).toEqual([]);
  });
});

describe('fichiers des itinéraires supprimés', () => {
  it('efface à la fermeture ceux que le projet ne référence plus', async () => {
    scheduleFitUploadsDeletion('p1', [upload('a'), upload('b')] as never);
    expect(bucket.deleted).toEqual([]);
    await expect(flushPendingFitDeletions('p1', project([upload('c')]) as never)).resolves.toBe(2);
    expect(bucket.deleted.sort()).toEqual(['a', 'b']);
  });

  it('garde ceux qu\'une annulation a rendus au projet', async () => {
    scheduleFitUploadsDeletion('p1', [upload('a'), upload('b')] as never);
    await flushPendingFitDeletions('p1', project([upload('a')]) as never);
    expect(bucket.deleted).toEqual(['b']);
  });

  it('ne touche qu\'au projet concerné et vide son attente', async () => {
    scheduleFitUploadsDeletion('p1', [upload('a')] as never);
    scheduleFitUploadsDeletion('p2', [upload('z')] as never);
    await flushPendingFitDeletions('p1', project() as never);
    expect(bucket.deleted).toEqual(['a']);
    await expect(flushPendingFitDeletions('p1', project() as never)).resolves.toBe(0);
    await flushPendingFitDeletions('p2', project() as never);
    expect(bucket.deleted).toEqual(['a', 'z']);
  });

  it('compte comme effacé un fichier déjà absent du bucket', async () => {
    bucket.missing.add('a');
    scheduleFitUploadsDeletion('p1', [upload('a'), upload(null)] as never);
    await expect(flushPendingFitDeletions('p1', project() as never)).resolves.toBe(1);
  });
});
