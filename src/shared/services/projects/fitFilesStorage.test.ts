import { describe, expect, it, vi } from 'vitest';

import { loadProjectPersistence } from '@/shared/test/projectPersistence';

/**
 * Fichiers .fit dans le bucket (traces GPS, fréquence cardiaque) : lisibles
 * par leur seul propriétaire (plus l'équipe d'un projet en co-édition), un
 * fichier absent n'est « supprimé » que sur un vrai 404 (jamais sur une
 * coupure réseau), et une copie de projet a ses propres fichiers.
 */

vi.mock('appwrite', () => import('@/shared/test/mockAppwriteSdk'));

const ME = 'user-A';

async function load() {
  return {
    ...(await loadProjectPersistence(ME)),
    fit: await import('./fitFiles'),
    live: await import('./liveSessions'),
  };
}

const fitFile = (name: string, content = 'FIT') => new File([content], name, { type: 'application/octet-stream', lastModified: 1 });

describe('envoi', () => {
  it('fichier lisible par son seul propriétaire ; en co-édition, aussi par l’équipe du projet', async () => {
    const { mock, fit, live } = await load();
    const solo = await fit.uploadProjectItineraryFitFiles('projet', 'it1', [fitFile('a.fit')]);
    expect(mock.files.get(solo.uploads[0]!.path!)?.permissions).toEqual([
      `read("user:${ME}")`, `update("user:${ME}")`, `delete("user:${ME}")`,
    ]);

    const release = live.registerLiveSession('projet');
    const shared = await fit.uploadProjectItineraryFitFiles('projet', 'it1', [fitFile('b.fit')]);
    release();
    expect(mock.files.get(shared.uploads[0]!.path!)?.permissions).toContain('read("team:pprojet")');
  });

  it('un fichier refusé n’empêche pas l’envoi des autres', async () => {
    const { fit } = await load();
    const broken = fitFile('casse.fit');
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(new Error('illisible'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await fit.uploadProjectItineraryFitFiles('projet', 'it1', [broken, fitFile('ok.fit')]);
    expect(result.failed.map((file) => file.name)).toEqual(['casse.fit']);
    expect(result.uploads.map((upload) => upload.name)).toEqual(['ok.fit']);
  });
});

describe('téléchargement', () => {
  it('relit le contenu ; seul un vrai 404 marque le fichier comme supprimé, pas une coupure réseau', async () => {
    const { mock, fit } = await load();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { uploads } = await fit.uploadProjectItineraryFitFiles('projet', 'it1', [fitFile('sortie.fit', 'données')]);
    const missing = { path: 'disparu', name: 'disparu.fit', size: 1, type: '', lastModified: 0 };

    const entries = await fit.downloadProjectItineraryFitFileEntries([...uploads, missing]);
    expect(await entries[0]!.file!.text()).toBe('données');
    expect(entries[1]).toMatchObject({ file: null, notFound: true });

    mock.dbNetworkDown = true;
    const offline = await fit.downloadProjectItineraryFitFileEntries(uploads);
    expect(offline[0]).toMatchObject({ file: null, notFound: false });
  });
});

describe('duplication', () => {
  it('la copie a ses propres fichiers ; l’original garde les siens', async () => {
    const { mock, fit } = await load();
    const { uploads } = await fit.uploadProjectItineraryFitFiles('source', 'it1', [fitFile('sortie.fit', 'données')]);
    const copied = await fit.duplicateProjectItineraryFitFiles([{ id: 'it1', fitUploads: uploads }, { id: 'it2', fitUploads: [] }], 'copie');

    const copy = copied.it1![0]!;
    expect(copy.path).not.toBe(uploads[0]!.path);
    expect(new TextDecoder().decode(mock.files.get(copy.path!)!.bytes)).toBe('données');
    expect(mock.files.has(uploads[0]!.path!)).toBe(true);
    expect(copied.it2).toBeUndefined();
  });

  it('source illisible : la copie n’a aucun fichier, jamais une référence à ceux de l’original', async () => {
    const { fit } = await load();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lost = { path: 'disparu', name: 'disparu.fit', size: 1, type: '', lastModified: 0 };
    expect(await fit.duplicateProjectItineraryFitFiles([{ id: 'it1', fitUploads: [lost] }], 'copie')).toEqual({ it1: [] });
  });
});
