import type { ProjectFolderSummary, ProjectSummary } from '@/shared/utils/projects';

export function buildFolderBreadcrumbs(
  folders: ProjectFolderSummary[],
  currentFolderId: string | null,
): ProjectFolderSummary[] {
  if (!currentFolderId) return [];

  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const seen = new Set<string>();
  const breadcrumb: ProjectFolderSummary[] = [];
  let cursor: string | null = currentFolderId;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = folderById.get(cursor);
    if (!folder) break;
    breadcrumb.push(folder);
    cursor = folder.parentFolderId;
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