import { beforeEach, describe, expect, it, vi } from 'vitest';

// Couche Appwrite / IndexedDB et fichier .redview remplacées : seule la
// logique d'orchestration (noms, rollback, échecs par fichier) est testée.
vi.mock('@/shared/services/projects', () => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  deleteFitUploads: vi.fn(),
  deleteProjectThumbnail: vi.fn(),
  duplicateProjectItineraryFitFiles: vi.fn(),
  duplicateProjectThumbnail: vi.fn(),
  getProject: vi.fn(),
  saveProject: vi.fn(),
}));
// Modules concrets importés par importProjects.ts (le lecteur est chargé à la demande).
vi.mock('@/features/redviewFile/lib/importProject', () => ({
  importRedviewFile: vi.fn(),
}));
// Accord aux données de santé des .fit (RGPD art. 9) : donné par défaut, refusé dans un test.
vi.mock('@/shared/services/healthDataConsent', () => ({
  ensureHealthDataConsent: vi.fn(),
}));
vi.mock('@/features/redviewFile/lib/messages', () => ({
  describeRedviewImportError: (error: unknown) => (error instanceof Error ? error.message : 'Fichier illisible'),
}));

import * as projectsApi from '@/shared/services/projects';
import * as redviewFile from '@/features/redviewFile/lib/importProject';
import * as healthConsent from '@/shared/services/healthDataConsent';
import type { ProjectRow } from '@/shared/services/projects';

import { duplicateProjectWithAssets } from './duplicateProject';
import { importProjectFiles } from './importProjects';

const api = vi.mocked(projectsApi);
const redview = vi.mocked(redviewFile);
const consent = vi.mocked(healthConsent);

function row(id: string, name: string, folderId: string | null = 'f1'): ProjectRow {
  return {
    id,
    user_id: 'u1',
    folder_id: folderId,
    name,
    privacy: 'private',
    size_bytes: 100,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    data: {
      name,
      privacy: 'private',
      savedAt: '2026-10-01T00:00:00.000Z',
      sizeBytes: 100,
      itineraries: [{ id: 'it-1', fitUploads: [{ id: 'fit-old' }] }],
    },
  } as unknown as ProjectRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getProject.mockResolvedValue(row('src', 'GT20'));
  api.createProject.mockResolvedValue(row('copy', 'GT20 copie'));
  api.duplicateProjectItineraryFitFiles.mockResolvedValue({ 'it-1': [{ id: 'fit-new' }] } as never);
  api.saveProject.mockResolvedValue(undefined as never);
  api.duplicateProjectThumbnail.mockResolvedValue(true);
  api.deleteProject.mockResolvedValue(undefined as never);
  api.deleteFitUploads.mockResolvedValue([]);
  api.deleteProjectThumbnail.mockResolvedValue(undefined as never);
  consent.ensureHealthDataConsent.mockResolvedValue(true);
});

describe('duplicateProjectWithAssets', () => {
  it('copies the document under a free name in the same folder, with its FIT files and thumbnail', async () => {
    const siblingNamesOf = vi.fn(() => ['GT20', 'GT20 copie']);
    const result = await duplicateProjectWithAssets('src', siblingNamesOf);

    expect(siblingNamesOf).toHaveBeenCalledWith('f1');
    expect(result).toMatchObject({ name: 'GT20 copie 2', thumbnailCopied: true });
    const [name, data, folderId] = api.createProject.mock.calls[0]!;
    expect(name).toBe('GT20 copie 2');
    expect(folderId).toBe('f1');
    expect(data).toMatchObject({ name: 'GT20 copie 2', savedAt: null, sizeBytes: null });
    // Never created with the source's FIT files: rolling the copy back
    // (deleteProject erases the files it references) would erase them.
    expect(data?.itineraries).toEqual([expect.objectContaining({ fitUploads: [] })]);
    expect(api.saveProject).toHaveBeenCalledWith('copy', expect.objectContaining({
      itineraries: [expect.objectContaining({ fitUploads: [{ id: 'fit-new' }] })],
    }));
    expect(api.duplicateProjectThumbnail).toHaveBeenCalledWith('src', 'copy');
    expect(api.deleteProject).not.toHaveBeenCalled();
  });

  it('without consent to health data, the copy has no FIT files and none are copied', async () => {
    consent.ensureHealthDataConsent.mockResolvedValue(false);
    await duplicateProjectWithAssets('src', () => []);
    expect(api.duplicateProjectItineraryFitFiles).not.toHaveBeenCalled();
    expect(api.saveProject).toHaveBeenCalledWith('copy', expect.objectContaining({
      itineraries: [expect.objectContaining({ fitUploads: [] })],
    }));
  });

  it('never mutates the source document', async () => {
    const source = row('src', 'GT20');
    api.getProject.mockResolvedValue(source);
    await duplicateProjectWithAssets('src', () => []);
    expect(source.data.name).toBe('GT20');
  });

  it('rolls back the partial copy (row, FIT files, thumbnail) when a step fails', async () => {
    api.saveProject.mockRejectedValue(new Error('cloud down'));

    await expect(duplicateProjectWithAssets('src', () => [])).rejects.toThrow('cloud down');
    expect(api.deleteProject).toHaveBeenCalledWith('copy');
    expect(api.deleteFitUploads).toHaveBeenCalledWith([{ id: 'fit-new' }]);
    expect(api.deleteProjectThumbnail).toHaveBeenCalledWith('copy');
  });

  it('cleans storage even if deleting the copied row fails', async () => {
    api.duplicateProjectThumbnail.mockRejectedValue(new Error('storage down'));
    api.deleteProject.mockRejectedValue(new Error('also down'));

    await expect(duplicateProjectWithAssets('src', () => [])).rejects.toThrow('storage down');
    expect(api.deleteFitUploads).toHaveBeenCalledWith([{ id: 'fit-new' }]);
  });

  it('creates nothing when the source project is missing', async () => {
    api.getProject.mockResolvedValue(null);
    await expect(duplicateProjectWithAssets('ghost', () => [])).rejects.toThrow();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.deleteProject).not.toHaveBeenCalled();
  });
});

describe('importProjectFiles', () => {
  const file = (name: string) => new File(['x'], name);

  it('imports every readable file, keeps going after a failure, and reserves the names used', async () => {
    const namesSeen: string[][] = [];
    const outcomes = [
      { row: row('p1', 'GT20 (importé)', null), skippedFitFileCount: 0 },
      new Error('Archive corrompue'),
      { row: row('p3', 'UTMB', null), skippedFitFileCount: 0 },
    ];
    redview.importRedviewFile.mockImplementation(async (_file, options) => {
      namesSeen.push([...options.siblingNames]);
      const outcome = outcomes[namesSeen.length - 1]!;
      if (outcome instanceof Error) throw outcome;
      return outcome as never;
    });

    const result = await importProjectFiles([file('a.redview'), file('b.redview'), file('c.redview')], {
      folderId: null,
      siblingNames: ['GT20'],
    });

    expect(result.imported.map((entry) => entry.id)).toEqual(['p1', 'p3']);
    expect(result.failures).toEqual(['b.redview : Archive corrompue']);
    expect(namesSeen).toEqual([['GT20'], ['GT20', 'GT20 (importé)'], ['GT20', 'GT20 (importé)']]);
  });

  it('reports a single failure without the file name', async () => {
    redview.importRedviewFile.mockRejectedValueOnce(new Error('Archive corrompue'));
    const result = await importProjectFiles([file('a.redview')], { folderId: 'f1', siblingNames: [] });
    expect(result).toEqual({ imported: [], failures: ['Archive corrompue'] });
  });
});
