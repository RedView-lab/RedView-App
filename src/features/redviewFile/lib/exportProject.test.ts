// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { createDefaultItinerary, createDefaultProject } from '@/features/itineraryPanel/lib/project/defaultState';
import type { ItineraryProject } from '@/features/itineraryPanel/types';

/** En-tête FIT de 14 octets annonçant 4 octets de données, puis les données et le CRC. */
const FIT_BYTES = Uint8Array.from([14, 0x10, 0, 0, 4, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0, 1, 2, 3, 4, 0, 0]);

vi.mock('@/shared/services/projects', () => ({
  loadProjectThumbnailBlob: async () => null,
  ownedFitFilePaths: async (paths: string[]) => new Set(paths.filter((path) => path.startsWith('mine-'))),
  downloadProjectItineraryFitFileEntries: async (uploads: Array<{ path: string; name: string }>) =>
    uploads.map((upload) => ({ path: upload.path, name: upload.name, file: new File([FIT_BYTES], upload.name), notFound: false })),
}));
vi.mock('@/shared/services/projects/auth', () => ({ getCurrentUserId: async () => 'alice' }));

const { buildRedviewFile } = await import('./exportProject');
const { readRedviewFile } = await import('./readRedviewFile');

function sharedProject(): ItineraryProject {
  const itinerary = {
    ...createDefaultItinerary(1),
    fitUploads: [
      { name: 'sortie-alice.fit', type: 'application/octet-stream', lastModified: 1, size: FIT_BYTES.length, path: 'mine-1' },
      { name: 'sortie-bob.fit', type: 'application/octet-stream', lastModified: 2, size: FIT_BYTES.length, path: 'bob-1' },
    ],
  };
  return {
    ...createDefaultProject(),
    name: 'Projet partagé',
    itineraries: [itinerary],
    activeItineraryId: itinerary.id,
    comments: [{
      id: 't1',
      anchor: { lng: 6, lat: 45, elevationM: null },
      createdBy: 'bob',
      createdAt: '2026-10-10T08:00:00Z',
      messages: [{ id: 'm1', authorId: 'bob', authorName: 'Bob Martin', text: 'Coucou @Alice', createdAt: '2026-10-10T08:00:00Z', mentions: ['alice'] }],
    }],
  };
}

describe('export .redview d’un projet partagé (G2-1)', () => {
  it('n’emporte que les .fit de l’expéditeur et pseudonymise les autres auteurs de commentaires', async () => {
    const { blob, fitFileCount, withheldFitFileCount } = await buildRedviewFile({ project: sharedProject() });
    expect(fitFileCount).toBe(1);
    expect(withheldFitFileCount).toBe(1);

    const read = await readRedviewFile(blob);
    expect(read.fitFiles.map((file) => file.name)).toEqual(['sortie-alice.fit']);
    const json = JSON.stringify(read.project);
    expect(json).not.toContain('sortie-bob');
    expect(json).not.toContain('Bob Martin');
    expect(json).not.toContain('"bob"');
    expect(read.project.comments?.[0].messages[0]).toMatchObject({ authorId: 'editor-2', authorName: 'Éditeur 2' });
  });
});
