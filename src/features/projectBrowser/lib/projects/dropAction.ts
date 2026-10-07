import type { ProjectFolderSummary, ProjectSummary } from '@/shared/services/projects';

export type DraggedBrowserItem = { type: 'project' | 'folder'; id: string };

export type DropAction =
  | { kind: 'move-project'; projectId: string; folderId: string | null }
  | { kind: 'move-folder'; folderId: string; parentFolderId: string | null };

/**
 * Déplacement à effectuer quand `dragged` est lâché sur `targetFolderId`
 * (`null` = racine), ou `null` s'il n'y a rien à faire : élément inconnu,
 * déjà à cet endroit, dossier lâché sur lui-même.
 */
export function resolveDropAction(
  dragged: DraggedBrowserItem | null,
  targetFolderId: string | null,
  folders: ProjectFolderSummary[],
  projects: ProjectSummary[],
): DropAction | null {
  if (!dragged) return null;
  if (dragged.type === 'project') {
    const project = projects.find((entry) => entry.id === dragged.id);
    if (!project || project.folderId === targetFolderId) return null;
    return { kind: 'move-project', projectId: project.id, folderId: targetFolderId };
  }
  const folder = folders.find((entry) => entry.id === dragged.id);
  if (!folder || folder.id === targetFolderId || folder.parentFolderId === targetFolderId) return null;
  return { kind: 'move-folder', folderId: folder.id, parentFolderId: targetFolderId };
}
