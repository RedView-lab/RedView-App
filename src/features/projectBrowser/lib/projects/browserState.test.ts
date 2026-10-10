import { describe, expect, it } from 'vitest';

import type { ProjectFolderSummary, ProjectSummary } from '@/shared/services/projects';

import { resolveDropAction } from './dropAction';
import { resolveCurrentFolderId, selectVisibleItems } from './visibility';

const STAMP = '2026-10-01T00:00:00.000Z';
const folder = (id: string, parentFolderId: string | null, name = id): ProjectFolderSummary => ({
  id,
  parentFolderId,
  name,
  privacy: 'private',
  createdAt: STAMP,
  updatedAt: STAMP,
});
const project = (id: string, folderId: string | null, name = id, sizeBytes = 10): ProjectSummary => ({
  id,
  folderId,
  name,
  privacy: 'private',
  sizeBytes,
  createdAt: STAMP,
  updatedAt: STAMP,
});

const folders = [folder('alps', null, 'Alpes'), folder('summer', 'alps', 'Été')];
const projects = [
  project('gt20', null, 'GT20'),
  project('utmb', 'alps', 'UTMB', 30),
  project('galibier', 'summer', 'Galibier', 5),
  project('orphan', 'deleted-folder', 'Orphelin'),
];

describe('selectVisibleItems', () => {
  it('shows the root content, orphans included', () => {
    const { visibleFolders, visibleProjects } = selectVisibleItems(folders, projects, null, '');
    expect(visibleFolders.map((entry) => entry.id)).toEqual(['alps']);
    expect(visibleProjects.map((entry) => entry.id)).toEqual(['gt20', 'orphan']);
  });

  it('shows a folder content with recursive sizes', () => {
    const { visibleFolders, visibleProjects } = selectVisibleItems(folders, projects, 'alps', '');
    expect(visibleFolders).toEqual([expect.objectContaining({ id: 'summer', aggregateSizeBytes: 5 })]);
    expect(visibleProjects.map((entry) => entry.id)).toEqual(['utmb']);
    expect(selectVisibleItems(folders, projects, null, '').visibleFolders[0]?.aggregateSizeBytes).toBe(35);
  });

  it('filters by a case-insensitive search', () => {
    expect(selectVisibleItems(folders, projects, null, '  gt ').visibleProjects.map((entry) => entry.id)).toEqual(['gt20']);
    expect(selectVisibleItems(folders, projects, null, 'xyz').visibleFolders).toEqual([]);
  });
});

describe('resolveCurrentFolderId', () => {
  it('falls back to the root when the folder no longer exists', () => {
    expect(resolveCurrentFolderId(folders, 'summer')).toBe('summer');
    expect(resolveCurrentFolderId(folders, 'deleted-folder')).toBeNull();
    expect(resolveCurrentFolderId(folders, null)).toBeNull();
  });
});

describe('resolveDropAction', () => {
  it('moves a project into another folder or to the root', () => {
    expect(resolveDropAction({ type: 'project', id: 'gt20' }, 'alps', folders, projects)).toEqual({
      kind: 'move-project',
      projectId: 'gt20',
      folderId: 'alps',
    });
    expect(resolveDropAction({ type: 'project', id: 'utmb' }, null, folders, projects)).toEqual({
      kind: 'move-project',
      projectId: 'utmb',
      folderId: null,
    });
  });

  it('moves a folder under another one', () => {
    expect(resolveDropAction({ type: 'folder', id: 'summer' }, null, folders, projects)).toEqual({
      kind: 'move-folder',
      folderId: 'summer',
      parentFolderId: null,
    });
  });

  it('does nothing when the item is already there, unknown, or dropped on itself', () => {
    expect(resolveDropAction({ type: 'project', id: 'utmb' }, 'alps', folders, projects)).toBeNull();
    expect(resolveDropAction({ type: 'folder', id: 'summer' }, 'alps', folders, projects)).toBeNull();
    expect(resolveDropAction({ type: 'folder', id: 'alps' }, 'alps', folders, projects)).toBeNull();
    expect(resolveDropAction({ type: 'project', id: 'ghost' }, null, folders, projects)).toBeNull();
    expect(resolveDropAction(null, null, folders, projects)).toBeNull();
  });
});

describe('dossiers en cycle (deux déplacements croisés depuis deux onglets, D3-1)', () => {
  // Onglet 1 : A dans B ; onglet 2 (liste périmée) : B dans A.
  const cyclic = [folder('a', 'b', 'A'), folder('b', 'a', 'B'), folder('c', null, 'C')];
  const inside = [project('ultra', 'a', 'Ultra 2026'), project('autre', null, 'Autre')];

  it('les dossiers du cycle restent à la racine, leurs projets accessibles', () => {
    const root = selectVisibleItems(cyclic, inside, null, '');
    expect(root.visibleFolders.map((entry) => entry.id).sort()).toEqual(['a', 'b', 'c']);
    expect(root.visibleProjects.map((entry) => entry.id)).toEqual(['autre']);
    expect(selectVisibleItems(cyclic, inside, 'a', '').visibleProjects.map((entry) => entry.id)).toEqual(['ultra']);
    expect(selectVisibleItems(cyclic, inside, 'a', '').visibleFolders).toEqual([]);
  });

  it('un dossier n’est jamais déplacé dans l’un de ses sous-dossiers', () => {
    const tree = [folder('a', null), folder('b', 'a'), folder('c', 'b')];
    expect(resolveDropAction({ type: 'folder', id: 'a' }, 'c', tree, [])).toBeNull();
    expect(resolveDropAction({ type: 'folder', id: 'c' }, 'a', tree, [])).toEqual({ kind: 'move-folder', folderId: 'c', parentFolderId: 'a' });
  });
});
