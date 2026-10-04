import { describe, expect, it } from 'vitest';

import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import { buildCopiedName } from './naming';
import {
  buildFolderBreadcrumbs,
  buildFolderPathLabel,
  collectFolderDescendantIds,
  computeFolderAggregateSize,
} from './tree';

const STAMP = '2026-10-04T12:00:00.000Z';

function folder(id: string, parentFolderId: string | null, name = id): ProjectFolderSummary {
  return { id, parentFolderId, name, privacy: 'private', createdAt: STAMP, updatedAt: STAMP };
}

function project(id: string, folderId: string | null, sizeBytes: number): ProjectSummary {
  return { id, folderId, name: id, privacy: 'private', sizeBytes, createdAt: STAMP, updatedAt: STAMP };
}

describe('buildCopiedName', () => {
  it('appends « copie », then a word-separated number (never « (2) », drawn ② by Rethink Sans)', () => {
    expect(buildCopiedName('GT20', [])).toBe('GT20 copie');
    expect(buildCopiedName('GT20', ['GT20 copie'])).toBe('GT20 copie 2');
    expect(buildCopiedName('GT20', ['gt20 COPIE', 'GT20 copie 2'])).toBe('GT20 copie 3');
    expect(buildCopiedName('GT20', ['GT20 copie'])).not.toMatch(/\(\d+\)/);
  });

  it('names an untitled project', () => {
    expect(buildCopiedName('   ', [])).toBe('Sans nom copie');
  });
});

describe('folder tree', () => {
  // root ─ a ─ b ─ c, and d at the root.
  const folders = [folder('a', null, 'Alpes'), folder('b', 'a', 'Été'), folder('c', 'b', 'Juillet'), folder('d', null)];

  it('builds the breadcrumb from the root down to the current folder', () => {
    expect(buildFolderBreadcrumbs(folders, 'c').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(buildFolderBreadcrumbs(folders, null)).toEqual([]);
    expect(buildFolderPathLabel(folders, 'c')).toBe('Projets / Alpes / Été / Juillet');
  });

  it('stops on a parent cycle instead of looping', () => {
    const cyclic = [folder('x', 'y'), folder('y', 'x')];
    expect(buildFolderBreadcrumbs(cyclic, 'x').map((entry) => entry.id)).toEqual(['y', 'x']);
  });

  it('stops at an unknown parent (orphan folder)', () => {
    expect(buildFolderBreadcrumbs([folder('o', 'deleted')], 'o').map((entry) => entry.id)).toEqual(['o']);
  });

  it('collects every descendant', () => {
    expect([...collectFolderDescendantIds(folders, 'a')].sort()).toEqual(['b', 'c']);
    expect(collectFolderDescendantIds(folders, 'c').size).toBe(0);
  });

  it('sums the size of the projects in a folder and its subfolders', () => {
    const projects = [project('p1', 'a', 100), project('p2', 'c', 50), project('p3', 'd', 7), project('p4', null, 1000)];
    expect(computeFolderAggregateSize('a', folders, projects)).toBe(150);
    expect(computeFolderAggregateSize('b', folders, projects)).toBe(50);
    expect(computeFolderAggregateSize('d', folders, projects)).toBe(7);
  });
});
