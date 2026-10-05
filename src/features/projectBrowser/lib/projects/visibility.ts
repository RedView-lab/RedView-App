import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

import { computeFolderAggregateSize } from './tree';

export type VisibleFolder = ProjectFolderSummary & { aggregateSizeBytes: number };

/**
 * Dossier affiché : celui demandé s'il existe encore (supprimé ailleurs,
 * déplacé : retour à la racine).
 */
export function resolveCurrentFolderId(
  folders: ProjectFolderSummary[],
  requestedFolderId: string | null,
): string | null {
  return requestedFolderId && folders.some((folder) => folder.id === requestedFolderId) ? requestedFolderId : null;
}

/**
 * Dossiers et projets affichés dans `currentFolderId`, filtrés par la
 * recherche. Un parent inconnu (supprimé, orphelin) compte comme la racine :
 * aucun élément ne doit devenir introuvable dans l'interface.
 */
export function selectVisibleItems(
  folders: ProjectFolderSummary[],
  projects: ProjectSummary[],
  currentFolderId: string | null,
  search: string,
): { visibleFolders: VisibleFolder[]; visibleProjects: ProjectSummary[] } {
  const query = search.trim().toLowerCase();
  const knownFolderIds = new Set(folders.map((folder) => folder.id));
  const effectiveParent = (parentId: string | null) => (parentId && knownFolderIds.has(parentId) ? parentId : null);
  const matches = (name: string) => !query || name.toLowerCase().includes(query);

  const visibleFolders = folders
    .filter((folder) => effectiveParent(folder.parentFolderId) === currentFolderId && matches(folder.name))
    .map((folder) => ({ ...folder, aggregateSizeBytes: computeFolderAggregateSize(folder.id, folders, projects) }));
  const visibleProjects = projects.filter(
    (project) => effectiveParent(project.folderId) === currentFolderId && matches(project.name),
  );
  return { visibleFolders, visibleProjects };
}
