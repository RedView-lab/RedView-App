import { describe, expect, it } from 'vitest';

import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import {
  patchFolder,
  patchProject,
  prependFolder,
  prependProjects,
  projectNamesIn,
  removeFolder,
  removeProject,
} from './projectLibraryCache';

const STAMP = '2026-10-01T00:00:00.000Z';
const project = (id: string, folderId: string | null = null): ProjectSummary => ({
  id,
  folderId,
  name: `Projet ${id}`,
  privacy: 'private',
  sizeBytes: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const folder = (id: string, parentFolderId: string | null = null): ProjectFolderSummary => ({
  id,
  parentFolderId,
  name: `Dossier ${id}`,
  privacy: 'private',
  createdAt: STAMP,
  updatedAt: STAMP,
});
const snapshot = () => ({ folders: [folder('f1')], projects: [project('a'), project('b', 'f1')], sharedProjects: [], fetchedAt: 42 });

describe('project library cache updates', () => {
  it('prepends new projects without duplicating an id and keeps extra fields', () => {
    const next = prependProjects(snapshot(), [project('c'), project('a')]);
    expect(next?.projects.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(next?.fetchedAt).toBe(42);
  });

  it('patches a project and marks it updated', () => {
    const next = patchProject(snapshot(), 'b', { name: 'Renommé', folderId: null });
    const patched = next?.projects.find((entry) => entry.id === 'b');
    expect(patched).toMatchObject({ name: 'Renommé', folderId: null });
    expect(patched?.updatedAt).not.toBe(STAMP);
    expect(next?.projects.find((entry) => entry.id === 'a')?.updatedAt).toBe(STAMP);
  });

  it('removes projects and folders', () => {
    expect(removeProject(snapshot(), 'a')?.projects.map((entry) => entry.id)).toEqual(['b']);
    expect(removeFolder(snapshot(), 'f1')?.folders).toEqual([]);
  });

  it('prepends and patches folders', () => {
    const withFolder = prependFolder(snapshot(), folder('f2', 'f1'));
    expect(withFolder?.folders.map((entry) => entry.id)).toEqual(['f2', 'f1']);
    expect(patchFolder(withFolder, 'f2', { parentFolderId: null })?.folders[0]?.parentFolderId).toBeNull();
  });

  it('leaves an empty cache untouched', () => {
    expect(prependProjects(undefined, [project('x')])).toBeUndefined();
    expect(patchProject(undefined, 'x', { name: 'y' })).toBeUndefined();
  });

  it('lists the project names of one folder', () => {
    expect(projectNamesIn(snapshot(), null)).toEqual(['Projet a']);
    expect(projectNamesIn(snapshot(), 'f1')).toEqual(['Projet b']);
    expect(projectNamesIn(undefined, null)).toEqual([]);
  });
});
