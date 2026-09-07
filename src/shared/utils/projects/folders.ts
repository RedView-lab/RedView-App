import {
  APPWRITE_DATABASE_ID,
  databases,
  FOLDERS_COLLECTION_ID,
  ID,
  Permission,
  PROJECTS_COLLECTION_ID,
  Query,
  Role,
} from '@/shared/services/appwrite';
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

function docToFolderRow(doc: any): ProjectFolderRow {
  return {
    id: doc.$id,
    user_id: doc.user_id,
    parent_folder_id: doc.parent_folder_id ?? null,
    name: doc.name || 'Dossier',
    privacy: doc.privacy || 'private',
    created_at: doc.$createdAt,
    updated_at: doc.$updatedAt,
  };
}

export async function listProjectFolders(): Promise<ProjectFolderSummary[]> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const result = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        FOLDERS_COLLECTION_ID,
        [Query.equal('user_id', userId), Query.orderDesc('$updatedAt'), Query.limit(100)],
      );
      if (result.documents) {
        return result.documents.map((doc) => folderRowToSummary(docToFolderRow(doc)));
      }
    } catch (e) {
      logger.projects.debug('Appwrite listProjectFolders fallback to local storage', e);
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
      const docId = ID.unique();
      const doc = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        FOLDERS_COLLECTION_ID,
        docId,
        {
          user_id: userId,
          parent_folder_id: parentFolderId ?? null,
          name: trimmed,
          privacy,
        },
        [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(userId)),
          Permission.delete(Role.user(userId)),
        ],
      );
      if (doc) {
        return folderRowToSummary(docToFolderRow(doc));
      }
    } catch (e) {
      logger.projects.debug('Appwrite createProjectFolder fallback to local storage', e);
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

  if (!isDev && !id.startsWith('folder-')) {
    try {
      await databases.updateDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, id, {
        name: trimmed,
      });
      return;
    } catch (e) {
      logger.projects.debug('Appwrite renameProjectFolder fallback to local storage', e);
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
  if (id === parentFolderId) return;

  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev && !id.startsWith('folder-')) {
    try {
      await databases.updateDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, id, {
        parent_folder_id: parentFolderId,
      });
      return;
    } catch (e) {
      logger.projects.debug('Appwrite moveProjectFolder fallback to local storage', e);
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

  if (!isDev && !id.startsWith('folder-')) {
    try {
      // Find and detach child projects
      const childProjects = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        PROJECTS_COLLECTION_ID,
        [Query.equal('folder_id', id)],
      );
      for (const p of childProjects.documents) {
        await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, p.$id, {
          folder_id: null,
        });
      }

      // Find and detach child folders
      const childFolders = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        FOLDERS_COLLECTION_ID,
        [Query.equal('parent_folder_id', id)],
      );
      for (const cf of childFolders.documents) {
        await databases.updateDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, cf.$id, {
          parent_folder_id: null,
        });
      }

      // Delete the folder itself
      await databases.deleteDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, id);
      return;
    } catch (e) {
      logger.projects.debug('Appwrite deleteProjectFolder fallback to local storage', e);
    }
  }

  const folders = readLocalFolders().filter((f) => f.id !== id);
  writeLocalFolders(folders);
}