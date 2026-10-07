import type { ProjectRow, ProjectSummary } from '@/shared/services/projects';

/** Ligne de projet (création, import, duplication) → entrée de la liste du gestionnaire. */
export function rowToSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.name,
    privacy: row.privacy,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
