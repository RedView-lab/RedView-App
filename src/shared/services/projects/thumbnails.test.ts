import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadProjectPersistence } from '@/shared/test/projectPersistence';

/**
 * Miniatures cloud (thumbnails.ts) : envoi, suppression et téléchargement ne
 * visent jamais un fichier absent — chaque 404 s'affichait en rouge dans la
 * console (premier envoi, suppression d'un projet sans miniature, duplication).
 */

vi.mock('appwrite', () => import('@/shared/test/mockAppwriteSdk'));

async function load() {
  const harness = await loadProjectPersistence('user-A');
  return { ...harness, thumbnails: await import('./thumbnails') };
}

// Graphe de modules transformé une fois, hors du délai de 5 s des tests (cf. projectViews.test.ts).
beforeAll(async () => {
  await load();
}, 60_000);

const BUCKET = 'project-thumbnails';
const storageCalls = (calls: string[]) =>
  calls.filter((call) => call.endsWith(`:${BUCKET}`) || call.startsWith('client.call:'));
const png = (marker = 1) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, marker])], { type: 'image/png' });
const cloudFile = (marker: number) => ({
  bucket: BUCKET,
  name: 'p.png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, marker]),
  permissions: ['read("user:user-A")', 'update("user:user-A")', 'delete("user:user-A")'],
});

describe('envoi', () => {
  it('premier envoi : liste puis création, sans suppression ; le suivant remplace le fichier', async () => {
    const { mock, thumbnails } = await load();
    await thumbnails.uploadProjectThumbnail('p1', png(1));
    expect(storageCalls(mock.calls)).toEqual([`listFiles:${BUCKET}`, `createFile:${BUCKET}`]);

    mock.calls = [];
    await thumbnails.uploadProjectThumbnail('p1', png(2));
    expect(storageCalls(mock.calls)).toEqual([`deleteFile:${BUCKET}`, `createFile:${BUCKET}`]);
    expect(mock.files.get('p1')?.bytes[4]).toBe(2);
  });

  it('miniature envoyée entre-temps par un autre appareil : remplacée', async () => {
    const { mock, thumbnails } = await load();
    await thumbnails.getProjectThumbnailUrls(['p1']); // listée absente
    mock.files.set('p1', cloudFile(9));
    mock.calls = [];
    await thumbnails.uploadProjectThumbnail('p1', png(3));
    expect(storageCalls(mock.calls)).toEqual([`createFile:${BUCKET}`, `deleteFile:${BUCKET}`, `createFile:${BUCKET}`]);
    expect(mock.files.get('p1')?.bytes[4]).toBe(3);
  });
});

describe('suppression', () => {
  it('projet sans miniature cloud : une liste, aucune suppression', async () => {
    const { mock, thumbnails } = await load();
    await thumbnails.deleteProjectThumbnail('p2');
    expect(storageCalls(mock.calls)).toEqual([`listFiles:${BUCKET}`]);
  });

  it('miniature envoyée dans la session : supprimée directement', async () => {
    const { mock, thumbnails } = await load();
    await thumbnails.uploadProjectThumbnail('p1', png());
    mock.calls = [];
    await thumbnails.deleteProjectThumbnail('p1');
    expect(storageCalls(mock.calls)).toEqual([`deleteFile:${BUCKET}`]);
    expect(mock.files.has('p1')).toBe(false);
  });
});

describe('téléchargement sans copie locale (duplication, export .redview)', () => {
  it('miniature absente du cloud : pas de téléchargement', async () => {
    const { mock, thumbnails } = await load();
    expect(await thumbnails.loadProjectThumbnailBlob('p3')).toBeNull();
    expect(storageCalls(mock.calls)).toEqual([`listFiles:${BUCKET}`]);
  });

  it('miniature présente : téléchargée', async () => {
    const { mock, thumbnails } = await load();
    mock.files.set('p4', cloudFile(4));
    const blob = await thumbnails.loadProjectThumbnailBlob('p4');
    expect(blob?.type).toBe('image/png');
    expect(storageCalls(mock.calls)).toEqual([`listFiles:${BUCKET}`, 'client.call:get']);
  });
});
