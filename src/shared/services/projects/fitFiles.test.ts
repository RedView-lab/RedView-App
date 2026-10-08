import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Effacement des fichiers FIT (traces GPS, fréquence cardiaque : RGPD) :
 * ceux d'un projet sont retrouvés dans son document, ceux d'un itinéraire
 * supprimé attendent la fermeture du projet pour qu'une annulation reste
 * possible.
 */

const bucket = vi.hoisted(() => ({ deleted: [] as string[], missing: new Set<string>() }));

vi.mock('@/shared/services/appwrite', () => ({
  FIT_FILES_BUCKET_ID: 'fit-files',
  ID: { unique: () => 'id' },
  Permission: {},
  Role: {},
  client: {},
  storage: {
    async deleteFile(bucketId: string, fileId: string) {
      expect(bucketId).toBe('fit-files');
      if (bucket.missing.has(fileId)) throw Object.assign(new Error('absent'), { code: 404 });
      bucket.deleted.push(fileId);
    },
  },
}));
vi.mock('./auth', () => ({ getCurrentUserId: async () => 'moi' }));
vi.mock('./liveSessions', () => ({ isLiveSession: () => false, sharedProjectTeamId: () => null }));

const { collectProjectFitUploads, flushPendingFitDeletions, scheduleFitUploadsDeletion } = await import('./fitFiles');

const upload = (path: string | null, name = `${path}.fit`) => ({ path, name, size: 1, type: '', lastModified: 0 });
const project = (...itineraries: Array<Array<ReturnType<typeof upload>>>) => ({
  itineraries: itineraries.map((fitUploads, index) => ({ id: `it${index}`, fitUploads })),
});

beforeEach(() => {
  bucket.deleted = [];
  bucket.missing.clear();
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
