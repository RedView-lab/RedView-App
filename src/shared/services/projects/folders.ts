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

import { isOwnDocument } from './access';
import { getCurrentUserId, isLocalFallbackUser, isOwnedBy, toCloudFailure } from './auth';
import { CLOUD_LIST_PAGE_SIZE, listAllCloudDocuments, listFirstCloudPage } from './cloudList';
import { ProjectCloudError } from './errors';
import { folderRowToSummary } from './mappers';
import { updateProjectDocumentKeepingBase } from './projectRows';
import type { ProjectFolderRow, ProjectFolderSummary, ProjectPrivacy } from './types';

const LOCAL_FOLDERS_KEY = 'redview:local-folders:v1';
/** Garde-fou des boucles de détachement (100 000 enfants). */
const MAX_DETACH_PASSES = 1000;

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

type CloudFolderDoc = {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
  $permissions?: string[];
  user_id?: string;
  parent_folder_id?: string | null;
  name?: string;
  privacy?: ProjectPrivacy;
};

function docToFolderRow(doc: CloudFolderDoc): ProjectFolderRow {
  return {
    id: doc.$id,
    user_id: doc.user_id ?? '',
    parent_folder_id: doc.parent_folder_id ?? null,
    name: doc.name || 'Dossier',
    privacy: doc.privacy || 'private',
    created_at: doc.$createdAt,
    updated_at: doc.$updatedAt,
  };
}

/** Dernière liste de dossiers reçue du cloud, servie hors-ligne (clé purgée à la déconnexion). */
const FOLDERS_CACHE_KEY_PREFIX = 'redview:project-folders-cache:v1:';

function writeFoldersCache(userId: string, folders: ProjectFolderSummary[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${FOLDERS_CACHE_KEY_PREFIX}${userId}`, JSON.stringify(folders));
  } catch {
    // cache au mieux
  }
}

function readFoldersCache(userId: string): ProjectFolderSummary[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`${FOLDERS_CACHE_KEY_PREFIX}${userId}`);
    return raw ? (JSON.parse(raw) as ProjectFolderSummary[]) : [];
  } catch {
    return [];
  }
}

export async function listProjectFolders(): Promise<ProjectFolderSummary[]> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev) {
    try {
      const documents = await listAllCloudDocuments<CloudFolderDoc>(FOLDERS_COLLECTION_ID, [
        Query.equal('user_id', userId),
        Query.orderDesc('$updatedAt'),
      ]);
      // Dossier d'un autre compte lisible par tous, `user_id` = moi : ignoré (access.ts).
      const folders = documents.filter((doc) => isOwnDocument(doc, userId)).map((doc) => folderRowToSummary(docToFolderRow(doc)));
      writeFoldersCache(userId, folders);
      return folders;
    } catch (e) {
      const error = toCloudFailure('listProjectFolders', e);
      if (error.kind !== 'offline') throw error;
      return readFoldersCache(userId);
    }
  }

  const local = readLocalFolders().filter((folder) => isOwnedBy(folder, userId));
  return local.map(folderRowToSummary);
}

export async function createProjectFolder(
  name = 'Nouveau dossier',
  parentFolderId?: string | null,
  privacy: ProjectPrivacy = 'private',
): Promise<ProjectFolderSummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Folder name cannot be empty');

  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

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
      return folderRowToSummary(docToFolderRow(doc));
    } catch (e) {
      throw toCloudFailure('createProjectFolder', e);
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

  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev && !id.startsWith('folder-')) {
    try {
      await databases.updateDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, id, {
        name: trimmed,
      });
      return;
    } catch (e) {
      throw toCloudFailure('renameProjectFolder', e);
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

/** `candidateId` est `folderId` lui-même ou l'un de ses sous-dossiers (chaîne de parents, cycle borné). */
function isSameOrInside(folders: readonly ProjectFolderSummary[], candidateId: string, folderId: string): boolean {
  const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentFolderId]));
  const seen = new Set<string>();
  let cursor: string | null | undefined = candidateId;
  while (cursor && !seen.has(cursor)) {
    if (cursor === folderId) return true;
    seen.add(cursor);
    cursor = parentOf.get(cursor);
  }
  return false;
}

/**
 * Déplace un dossier. Refusé (`rejected`) dans l'un de ses sous-dossiers,
 * vérifié sur la liste relue à l'instant : deux onglets ou appareils, chacun
 * sur une liste périmée, créaient sinon un cycle (A dans B, B dans A) qui
 * rendait les deux dossiers et leurs projets introuvables (D3-1).
 */
export async function moveProjectFolder(
  id: string,
  parentFolderId: string | null,
): Promise<void> {
  if (id === parentFolderId) return;

  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (parentFolderId && isSameOrInside(await listProjectFolders(), parentFolderId, id)) {
    throw new ProjectCloudError('rejected');
  }

  if (!isDev && !id.startsWith('folder-')) {
    try {
      await databases.updateDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, id, {
        parent_folder_id: parentFolderId,
      });
      return;
    } catch (e) {
      throw toCloudFailure('moveProjectFolder', e);
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
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev && !id.startsWith('folder-')) {
    try {
      // Détacher TOUS les projets enfants (sans Query.limit, Appwrite n'en renvoie
      // que 25). Les projets détachés sortent du filtre : on relit la première
      // page jusqu'à ce qu'elle soit vide. Le dossier n'est supprimé qu'ensuite :
      // un échec en cours de route laisse un dossier existant, jamais d'orphelins.
      for (let pass = 0; pass < MAX_DETACH_PASSES; pass++) {
        const children = await listFirstCloudPage<{ $id: string; $updatedAt: string }>(PROJECTS_COLLECTION_ID, [
          Query.equal('user_id', userId),
          Query.equal('folder_id', id),
          Query.select(['$id', '$updatedAt', 'folder_id']),
        ]);
        if (children.length === 0) break;
        for (const child of children) {
          await updateProjectDocumentKeepingBase(child.$id, { folder_id: null }, { folder_id: null });
        }
        if (children.length < CLOUD_LIST_PAGE_SIZE) break;
      }

      // Détacher tous les sous-dossiers (même principe).
      for (let pass = 0; pass < MAX_DETACH_PASSES; pass++) {
        const children = await listFirstCloudPage(FOLDERS_COLLECTION_ID, [
          Query.equal('user_id', userId),
          Query.equal('parent_folder_id', id),
        ]);
        if (children.length === 0) break;
        for (const child of children) {
          await databases.updateDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, child.$id, {
            parent_folder_id: null,
          });
        }
        if (children.length < CLOUD_LIST_PAGE_SIZE) break;
      }

      // Supprime le dossier lui-même
      await databases.deleteDocument(APPWRITE_DATABASE_ID, FOLDERS_COLLECTION_ID, id);
      return;
    } catch (e) {
      throw toCloudFailure('deleteProjectFolder', e);
    }
  }

  const folders = readLocalFolders().filter((f) => f.id !== id);
  writeLocalFolders(folders);
}