import type {
  ProjectFolderRow,
  ProjectFolderSummary,
  ProjectRow,
  ProjectSummary,
} from './types';

export function rowToSummary(
  row: Pick<ProjectRow, 'id' | 'folder_id' | 'name' | 'privacy' | 'size_bytes' | 'created_at' | 'updated_at'>,
): ProjectSummary {
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

export function folderRowToSummary(
  row: Pick<ProjectFolderRow, 'id' | 'parent_folder_id' | 'name' | 'privacy' | 'created_at' | 'updated_at'>,
): ProjectFolderSummary {
  return {
    id: row.id,
    parentFolderId: row.parent_folder_id,
    name: row.name,
    privacy: row.privacy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}