import { supabase } from '@/shared/services/supabase';
import { logger } from '@/shared/lib/logger';

import { getCurrentUserId } from './auth';
import { folderRowToSummary } from './mappers';
import type { ProjectFolderRow, ProjectFolderSummary, ProjectPrivacy } from './types';

const LOCAL_FOLDERS_KEY = 'redview:local-folders:v1';

function readLocalFolders(): ProjectFolderRow[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_FOLDERS_KEY);
    return raw ? (JSON.parse(raw) as ProjectFolderRow[]) : [];
  } catch {
    return [];
  }
}

function writeLocalFolders(folders: ProjectFolderRow[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_FOLDERS_KEY, JSON.stringify(folders));
  } catch (e) {
    logger.projects.warn('Failed to save local folders', e);
  }
}

export async function listProjectFolders(): Promise<ProjectFolderSummary[]> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { data, error } = await supabase
        .from('project_folders')
        .select('id, parent_folder_id, name, privacy, created_at, updated_at')
        .order('updated_at', { ascending: false });
      if (!error && data) {
        return data.map((row) => folderRowToSummary(row as ProjectFolderRow));
      }
    } catch (e) {
      logger.projects.debug('Supabase listProjectFolders fallback to local storage', e);
    }
  }

  const local = readLocalFolders();
  return local.map(folderRowToSummary);
}

export async function createProjectFolder(
  name = 'Nouveau dossier',
  parentFolderId?: string | null,
  privacy: ProjectPrivacy = 'private',
): Promise<ProjectFolderSummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name cannot be empty');

  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { data, error } = await supabase
        .from('project_folders')
        .insert({
          user_id: userId,
          parent_folder_id: parentFolderId ?? null,
          name: trimmed,
          privacy,
        })
        .select('id, parent_folder_id, name, privacy, created_at, updated_at')
        .single();
      if (!error && data) {
        return folderRowToSummary(data as ProjectFolderRow);
      }
    } catch (e) {
      logger.projects.debug('Supabase createProjectFolder fallback to local storage', e);
    }
  }

  const now = new Date().toISOString();
  const localFolder: ProjectFolderRow = {
    id: 'folder-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    user_id: userId,
    parent_folder_id: parentFolderId ?? null,
    name: trimmed,
    privacy,
    created_at: now,
    updated_at: now,
  };

  const folders = readLocalFolders();
  folders.unshift(localFolder);
  writeLocalFolders(folders);
  return folderRowToSummary(localFolder);
}

export async function renameProjectFolder(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name cannot be empty');

  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { error } = await supabase.from('project_folders').update({ name: trimmed }).eq('id', id);
      if (!error) return;
    } catch (e) {
      logger.projects.debug('Supabase renameProjectFolder fallback to local storage', e);
    }
  }

  const folders = readLocalFolders();
  const target = folders.find((f) => f.id === id);
  if (target) {
    target.name = trimmed;
    target.updated_at = new Date().toISOString();
    writeLocalFolders(folders);
  }
}

export async function moveProjectFolder(
  id: string,
  parentFolderId: string | null,
): Promise<void> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { error } = await supabase.rpc('move_project_folder', {
        target_folder_id: id,
        next_parent_folder_id: parentFolderId,
      });
      if (!error) return;
    } catch (e) {
      logger.projects.debug('Supabase moveProjectFolder fallback to local storage', e);
    }
  }

  const folders = readLocalFolders();
  const target = folders.find((f) => f.id === id);
  if (target) {
    target.parent_folder_id = parentFolderId;
    target.updated_at = new Date().toISOString();
    writeLocalFolders(folders);
  }
}

export async function deleteProjectFolder(id: string): Promise<void> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { error } = await supabase.rpc('delete_project_folder', {
        target_folder_id: id,
      });
      if (!error) return;
    } catch (e) {
      logger.projects.debug('Supabase deleteProjectFolder fallback to local storage', e);
    }
  }

  const folders = readLocalFolders().filter((f) => f.id !== id);
  writeLocalFolders(folders);
}