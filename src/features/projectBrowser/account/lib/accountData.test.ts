// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ zip: null as Blob | null }));

vi.mock('@/shared/services/appwrite', () => ({
  account: { get: async () => ({ $id: 'alice', name: 'Alice', email: 'alice@example.test', emailVerification: true, registration: '2026-01-01', passwordUpdate: '', prefs: {} }) },
  getAppwriteJwt: async () => 'jwt',
}));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: () => {}, countBucket: () => '1' }));
vi.mock('@/shared/services/projects', () => ({
  listProjectBrowserSnapshot: async () => ({
    folders: [],
    projects: [{ id: 'own1', name: 'Mon projet' }],
    sharedProjects: [{ id: 'shared1', name: 'Projet de Bob', updatedAt: '2026-10-10' }],
  }),
  getProject: async (id: string) => (id === 'own1'
    ? { name: 'Mon projet', data: { name: 'Mon projet', itineraries: [{ id: 'i1', fitUploads: [{ name: 'a.fit', path: 'fit-own' }] }] } }
    : {
        name: 'Projet de Bob',
        data: {
          name: 'Projet de Bob',
          itineraries: [],
          comments: [{
            id: 't1',
            anchor: { lng: 6, lat: 45, elevationM: null },
            messages: [
              { id: 'm1', authorId: 'bob', authorName: 'Bob', text: 'Salut', createdAt: '2026-10-10T08:00:00Z' },
              { id: 'm2', authorId: 'alice', authorName: 'Alice', text: 'Ravito au km 42', createdAt: '2026-10-10T08:05:00Z' },
            ],
          }],
        },
      }),
  collectProjectFitUploads: (project: { itineraries: Array<{ fitUploads?: Array<{ path?: string }> }> }) =>
    project.itineraries.flatMap((itinerary) => itinerary.fitUploads ?? []),
  listOwnedFitFiles: async () => [{ id: 'fit-own', name: 'a.fit' }, { id: 'fit-in-bob', name: 'sortie-chez-bob.fit' }],
  downloadProjectItineraryFitFileEntries: async (uploads: Array<{ path: string; name: string }>) =>
    uploads.map((upload) => ({ path: upload.path, name: upload.name, file: new File([new Uint8Array([1, 2, 3])], upload.name), notFound: false })),
}));
vi.mock('@/shared/services/projects/projectViews', () => ({
  readProjectView: async (id: string) => ({ view: { activeItineraryId: `${id}-it` } }),
}));
vi.mock('@/features/redviewFile/lib/exportProject', () => ({
  buildRedviewFile: async () => ({ blob: new Blob([new Uint8Array([9])]) }),
  downloadBlob: (blob: Blob) => { captured.zip = blob; },
}));

const { exportAccountData } = await import('./accountData');
const { openZip, readZipEntry } = await import('@/features/redviewFile/lib/zip/zipReader');

describe('export « Vos données » (A10-1)', () => {
  it('ajoute les .fit déposés hors de ses projets, ses commentaires dans les projets partagés et ses vues', async () => {
    const result = await exportAccountData();
    expect(result.sharedFitFileCount).toBe(1);

    const zip = await openZip(captured.zip!, { maxEntries: 100 });
    const names = [...zip.entries.keys()];
    expect(names).toContain('fit-partages/sortie-chez-bob.fit');
    // Le .fit de son propre projet est déjà dans son .redview : pas en double.
    expect(names.filter((name) => name.includes('a.fit'))).toEqual([]);

    const compte = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, zip.entries.get('compte.json')!, 1_000_000)));
    expect(compte.commentsInSharedProjects).toEqual([
      expect.objectContaining({ projectId: 'shared1', threadId: 't1', messages: [expect.objectContaining({ id: 'm2', text: 'Ravito au km 42' })] }),
    ]);
    expect(JSON.stringify(compte.commentsInSharedProjects)).not.toContain('Salut');
    expect(compte.views.map((entry: { projectId: string }) => entry.projectId)).toEqual(['own1', 'shared1']);
  });
});
