import type { ProjectFolderSummary, ProjectSummary } from '@/shared/services/projects';
import { translateAppText } from '@/shared/i18n';

/**
 * Dossiers dont la chaîne de parents boucle (A dans B et B dans A : deux
 * déplacements croisés depuis deux onglets ou appareils). Ils sont traités
 * comme à la racine : sinon ni eux ni leurs projets n'étaient atteignables (D3-1).
 */
export function findCyclicFolderIds(folders: ProjectFolderSummary[]): Set<string> {
  const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentFolderId]));
  const cyclic = new Set<string>();
  for (const folder of folders) {
    const seen = new Set<string>();
    let cursor: string | null | undefined = folder.id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (cursor === folder.id) cyclic.add(folder.id);
  }
  return cyclic;
}

export function buildFolderBreadcrumbs(
  folders: ProjectFolderSummary[],
  currentFolderId: string | null,
): ProjectFolderSummary[] {
  if (!currentFolderId) return [];

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const cyclic = findCyclicFolderIds(folders);
  const seen = new Set<string>();
  const breadcrumb: ProjectFolderSummary[] = [];
  let cursor: string | null = currentFolderId;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = folderById.get(cursor);
    if (!folder) break;
    breadcrumb.push(folder);
    // Dossier pris dans un cycle : à la racine, comme dans la liste.
    cursor = cyclic.has(folder.id) ? null : folder.parentFolderId;
  }

  return breadcrumb.reverse();
}

export function computeFolderAggregateSize(
  folderId: string,
  folders: ProjectFolderSummary[],
  projects: ProjectSummary[],
): number {
  const includedFolderIds = new Set<string>([folderId]);
  const queue = [folderId];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    for (const folder of folders) {
      if (folder.parentFolderId !== currentId || includedFolderIds.has(folder.id)) continue;
      includedFolderIds.add(folder.id);
      queue.push(folder.id);
    }
  }

  return projects.reduce((total, project) => {
    if (project.folderId && includedFolderIds.has(project.folderId)) {
      return total + project.sizeBytes;
    }
    return total;
  }, 0);
}

export function collectFolderDescendantIds(
  folders: ProjectFolderSummary[],
  folderId: string,
): Set<string> {
  const descendants = new Set<string>();
  const queue = [folderId];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    for (const folder of folders) {
      if (folder.parentFolderId !== currentId || descendants.has(folder.id)) continue;
      descendants.add(folder.id);
      queue.push(folder.id);
    }
  }

  return descendants;
}

export function buildFolderPathLabel(
  folders: ProjectFolderSummary[],
  folderId: string,
): string {
  const breadcrumb = buildFolderBreadcrumbs(folders, folderId);
  return [translateAppText('Projets'), ...breadcrumb.map((folder) => folder.name)].join(' / ');
}