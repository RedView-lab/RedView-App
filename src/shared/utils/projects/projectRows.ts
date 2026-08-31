import { createDefaultProject } from '@/features/itineraryPanel/lib/project';
import { supabase } from '@/shared/services/supabase';
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

export async function listProjects(): Promise<ProjectSummary[]> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('id, folder_id, name, privacy, size_bytes, created_at, updated_at')
        .order('updated_at', { ascending: false });
      if (!error && data) {
        return data.map((row) => rowToSummary(row as ProjectRow));
      }
    } catch (e) {
      logger.projects.debug('Supabase listProjects fallback to local storage', e);
    }
  }

  const local = readLocalProjects();
  return local.map((row) => rowToSummary(row));
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const userId = await getCurrentUserId().catch(() => 'dev-user-001');
  const isDev = userId === 'dev-user-001';

  if (!isDev) {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (!error && data) {
        return data as ProjectRow;
      }
    } catch (e) {
      logger.projects.debug('Supabase getProject fallback to local storage', e);
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
      const { data, error } = await supabase
        .from('projects')
        .insert({
          user_id: userId,
          folder_id: folderId ?? null,
          name: finalProject.name,
          data: finalProject,
          size_bytes: computeProjectSizeBytes(finalProject),
          privacy: finalProject.privacy ?? 'private',
        })
        .select('*')
        .single();
      if (!error && data) {
        return data as ProjectRow;
      }
    } catch (e) {
      logger.projects.debug('Supabase createProject fallback to local storage', e);
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
      const { error } = await supabase
        .from('projects')
        .update({
          name: project.name,
          data: project,
          size_bytes: computeProjectSizeBytes(project),
          privacy: project.privacy ?? 'private',
        })
        .eq('id', id);
      if (!error) return;
    } catch (e) {
      logger.projects.debug('Supabase saveProject fallback to local storage', e);
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

  if (!isDev) {
    try {
      const current = await getProject(id);
      if (current) {
        const nextData: ItineraryProject = { ...current.data, name: trimmed };
        const { error } = await supabase
          .from('projects')
          .update({
            name: trimmed,
            data: nextData,
            size_bytes: computeProjectSizeBytes(nextData),
          })
          .eq('id', id);
        if (!error) return;
      }
    } catch (e) {
      logger.projects.debug('Supabase renameProject fallback to local storage', e);
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

  if (!isDev) {
    try {
      const { error } = await supabase.from('projects').update({ folder_id: folderId }).eq('id', id);
      if (!error) return;
    } catch (e) {
      logger.projects.debug('Supabase moveProjectToFolder fallback to local storage', e);
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

  if (!isDev) {
    try {
      const { error } = await supabase.from('projects').delete().eq('id', id);
      if (!error) return;
    } catch (e) {
      logger.projects.debug('Supabase deleteProject fallback to local storage', e);
    }
  }

  const projects = readLocalProjects().filter((p) => p.id !== id);
  writeLocalProjects(projects);
}