import { createDefaultProject } from '@/features/itineraryPanel/lib/project';
import {
  APPWRITE_DATABASE_ID,
  databases,
  ID,
  Permission,
  PROJECTS_COLLECTION_ID,
  Query,
  Role,
} from '@/shared/services/appwrite';
import { logger } from '@/shared/lib/logger';

import { getCurrentUserId } from './auth';
import { computeProjectSizeBytes } from './limits';
import { rowToSummary } from './mappers';
import type { ItineraryProject, ProjectRow, ProjectSummary } from './types';

const LOCAL_PROJECTS_KEY = 'redview:local-projects:v1';

function readLocalProjects(): ProjectRow[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as ProjectRow[]) : [];
  } catch {
    return [];
  }
}

function writeLocalProjects(projects: ProjectRow[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
  } catch (e) {
    logger.projects.warn('Failed to save local projects', e);
  }
}

function docToProjectRow(doc: any): ProjectRow {
  let parsedData: ItineraryProject;
  if (typeof doc.data === 'string') {
    try {
      parsedData = JSON.parse(doc.data);
    } catch {
      parsedData = createDefaultProject();
    }
  } else if (doc.data && typeof doc.data === 'object') {
    parsedData = doc.data;
  } else {
    parsedData = createDefaultProject();
  }

  return {
    id: doc.$id,
    user_id: doc.user_id,
    folder_id: doc.folder_id ?? null,
    name: doc.name || parsedData.name || 'Untitled',
    data: parsedData,
    size_bytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : computeProjectSizeBytes(parsedData),
    privacy: doc.privacy || 'private',
    created_at: doc.$createdAt,
    updated_at: doc.$updatedAt,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const result = await databases.listDocuments(
        APPWRITE_DATABASE_ID,
        PROJECTS_COLLECTION_ID,
        [Query.equal('user_id', userId), Query.orderDesc('$updatedAt'), Query.limit(100)],
      );

      if (result.documents) {
        return result.documents.map((doc) => rowToSummary(docToProjectRow(doc)));
      }
    } catch (e) {
      logger.projects.debug('Appwrite listProjects fallback to local storage', e);
    }
  }

  const local = readLocalProjects();
  return local.map((row) => rowToSummary(row));
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev && !id.startsWith('local-')) {
    try {
      const doc = await databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id);
      if (doc) {
        return docToProjectRow(doc);
      }
    } catch (e) {
      logger.projects.debug('Appwrite getProject fallback to local storage', e);
    }
  }

  const local = readLocalProjects();
  return local.find((p) => p.id === id) ?? null;
}

export async function createProject(
  name?: string,
  initialData?: ItineraryProject,
  folderId?: string | null,
): Promise<ProjectRow> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';
  const baseProject: ItineraryProject = initialData ?? createDefaultProject();
  const finalProject: ItineraryProject = name ? { ...baseProject, name } : baseProject;

  if (!isDev) {
    try {
      const docId = ID.unique();
      const payload = {
        user_id: userId,
        folder_id: folderId ?? null,
        name: finalProject.name,
        data: JSON.stringify(finalProject),
        size_bytes: computeProjectSizeBytes(finalProject),
        privacy: finalProject.privacy ?? 'private',
      };

      const doc = await databases.createDocument(
        APPWRITE_DATABASE_ID,
        PROJECTS_COLLECTION_ID,
        docId,
        payload,
        [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(userId)),
          Permission.delete(Role.user(userId)),
        ],
      );

      if (doc) {
        return docToProjectRow(doc);
      }
    } catch (e) {
      logger.projects.debug('Appwrite createProject fallback to local storage', e);
    }
  }

  const now = new Date().toISOString();
  const localRow: ProjectRow = {
    id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    user_id: userId,
    folder_id: folderId ?? null,
    name: finalProject.name,
    data: finalProject,
    size_bytes: computeProjectSizeBytes(finalProject),
    privacy: finalProject.privacy ?? 'private',
    created_at: now,
    updated_at: now,
  };

  const projects = readLocalProjects();
  projects.unshift(localRow);
  writeLocalProjects(projects);
  return localRow;
}

export async function saveProject(id: string, project: ItineraryProject): Promise<void> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev && !id.startsWith('local-')) {
    try {
      await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id, {
        name: project.name,
        data: JSON.stringify(project),
        size_bytes: computeProjectSizeBytes(project),
        privacy: project.privacy ?? 'private',
      });
      return;
    } catch (e) {
      logger.projects.debug('Appwrite saveProject fallback to local storage', e);
    }
  }

  const projects = readLocalProjects();
  const index = projects.findIndex((p) => p.id === id);
  const now = new Date().toISOString();

  if (index !== -1) {
    projects[index] = {
      ...projects[index],
      name: project.name,
      data: project,
      size_bytes: computeProjectSizeBytes(project),
      privacy: project.privacy ?? 'private',
      updated_at: now,
    };
    writeLocalProjects(projects);
  } else {
    projects.unshift({
      id,
      user_id: userId,
      folder_id: null,
      name: project.name,
      data: project,
      size_bytes: computeProjectSizeBytes(project),
      privacy: project.privacy ?? 'private',
      created_at: now,
      updated_at: now,
    });
    writeLocalProjects(projects);
  }
}

export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name cannot be empty');

  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev && !id.startsWith('local-')) {
    try {
      const current = await getProject(id);
      if (current) {
        const nextData: ItineraryProject = { ...current.data, name: trimmed };
        await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id, {
          name: trimmed,
          data: JSON.stringify(nextData),
          size_bytes: computeProjectSizeBytes(nextData),
        });
        return;
      }
    } catch (e) {
      logger.projects.debug('Appwrite renameProject fallback to local storage', e);
    }
  }

  const projects = readLocalProjects();
  const target = projects.find((p) => p.id === id);
  if (target) {
    target.name = trimmed;
    target.data = { ...target.data, name: trimmed };
    target.updated_at = new Date().toISOString();
    writeLocalProjects(projects);
  }
}

export async function moveProjectToFolder(
  id: string,
  folderId: string | null,
): Promise<void> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev && !id.startsWith('local-')) {
    try {
      await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id, {
        folder_id: folderId,
      });
      return;
    } catch (e) {
      logger.projects.debug('Appwrite moveProjectToFolder fallback to local storage', e);
    }
  }

  const projects = readLocalProjects();
  const target = projects.find((p) => p.id === id);
  if (target) {
    target.folder_id = folderId;
    target.updated_at = new Date().toISOString();
    writeLocalProjects(projects);
  }
}

export async function deleteProject(id: string): Promise<void> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev && !id.startsWith('local-')) {
    try {
      await databases.deleteDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id);
      return;
    } catch (e) {
      logger.projects.debug('Appwrite deleteProject fallback to local storage', e);
    }
  }

  const projects = readLocalProjects().filter((p) => p.id !== id);
  writeLocalProjects(projects);
}