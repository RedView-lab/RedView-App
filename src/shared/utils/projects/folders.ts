import { supabase } from '@/shared/services/supabase';

import { getCurrentUserId } from './auth';
import { folderRowToSummary } from './mappers';
import type { ProjectFolderRow, ProjectFolderSummary, ProjectPrivacy } from './types';

export async function listProjectFolders(): Promise<ProjectFolderSummary[]> {
  const { data, error } = await supabase
    .from('project_folders')
    .select('id, parent_folder_id, name, privacy, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => folderRowToSummary(row as ProjectFolderRow));
}

export async function createProjectFolder(
  name = 'Nouveau dossier',
  parentFolderId?: string | null,
  privacy: ProjectPrivacy = 'private',
): Promise<ProjectFolderSummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name cannot be empty');

  const { data, error } = await supabase
    .from('project_folders')
    .insert({
      user_id: await getCurrentUserId(),
      parent_folder_id: parentFolderId ?? null,
      name: trimmed,
      privacy,
    })
    .select('id, parent_folder_id, name, privacy, created_at, updated_at')
    .single();
  if (error) throw error;
  return folderRowToSummary(data as ProjectFolderRow);
}

export async function renameProjectFolder(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name cannot be empty');

  const { error } = await supabase.from('project_folders').update({ name: trimmed }).eq('id', id);
  if (error) throw error;
}

export async function moveProjectFolder(
  id: string,
  parentFolderId: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('move_project_folder', {
    target_folder_id: id,
    next_parent_folder_id: parentFolderId,
  });
  if (error) throw error;
}

export async function deleteProjectFolder(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_project_folder', {
    target_folder_id: id,
  });
  if (error) throw error;
}