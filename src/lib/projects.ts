/**
 * Project persistence layer.
 *
 * Each row in `public.projects` stores:
 *   - identification (id, user_id, name, privacy, timestamps)
 *   - the full editor state in `data` JSONB so the client can evolve its
 *     schema without DB migrations.
 *
 * Row Level Security (see `supabase-projects-migration.sql`) means every
 * call here is implicitly scoped to the authenticated user — we never
 * pass user_id from the client on read/update/delete; on insert it is
 * required by the policy and explicitly set from the active session.
 */
import { supabase } from './supabase';
import type { ItineraryProject } from '@/features/itineraryPanel/types';
import { createDefaultProject } from '@/features/itineraryPanel/defaultState';

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  data: ItineraryProject;
  size_bytes: number;
  privacy: 'private' | 'public';
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  privacy: 'private' | 'public';
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

function rowToSummary(row: Pick<
  ProjectRow,
  'id' | 'name' | 'privacy' | 'size_bytes' | 'created_at' | 'updated_at'
>): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    privacy: row.privacy,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function computeSizeBytes(data: ItineraryProject): number {
  try {
    // Cheap byte estimate: UTF-8 length of the JSON payload. Good enough
    // for a "336mo"-style indicator without serialising twice.
    return new Blob([JSON.stringify(data)]).size;
  } catch {
    return 0;
  }
}

/** List the current user's projects, most-recently-edited first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, privacy, size_bytes, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToSummary);
}

/** Fetch a single project (including its `data` payload). */
export async function getProject(id: string): Promise<ProjectRow | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ProjectRow | null) ?? null;
}

/**
 * Create a new project for the current user. The initial editor state is
 * either supplied by the caller or generated from `createDefaultProject()`.
 *
 * Returns the inserted row so the caller can immediately open it in the
 * editor without a follow-up SELECT.
 */
export async function createProject(
  name?: string,
  initialData?: ItineraryProject,
): Promise<ProjectRow> {
  const { data: sessionData, error: sessionErr } =
    await supabase.auth.getUser();
  if (sessionErr) throw sessionErr;
  const user = sessionData.user;
  if (!user) throw new Error('Not authenticated');

  const baseProject: ItineraryProject = initialData ?? createDefaultProject();
  const finalProject: ItineraryProject = name
    ? { ...baseProject, name }
    : baseProject;

  const insertRow = {
    user_id: user.id,
    name: finalProject.name,
    data: finalProject,
    size_bytes: computeSizeBytes(finalProject),
    privacy: finalProject.privacy ?? 'private',
  };

  const { data, error } = await supabase
    .from('projects')
    .insert(insertRow)
    .select('*')
    .single();
  if (error) throw error;
  return data as ProjectRow;
}

/**
 * Persist the full `data` payload of a project. Also keeps the top-level
 * `name`, `privacy` and `size_bytes` columns in sync so the project list
 * can render fast metadata without parsing JSONB.
 */
export async function saveProject(
  id: string,
  project: ItineraryProject,
): Promise<void> {
  const { error } = await supabase
    .from('projects')
    .update({
      name: project.name,
      data: project,
      size_bytes: computeSizeBytes(project),
      privacy: project.privacy ?? 'private',
    })
    .eq('id', id);
  if (error) throw error;
}

/** Rename a project (updates both the column and the embedded JSONB name). */
export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name cannot be empty');

  // Read-modify-write so we keep `data.name` and the column in sync without
  // racing the autosaver.
  const current = await getProject(id);
  if (!current) throw new Error('Project not found');
  const nextData: ItineraryProject = { ...current.data, name: trimmed };

  const { error } = await supabase
    .from('projects')
    .update({
      name: trimmed,
      data: nextData,
      size_bytes: computeSizeBytes(nextData),
    })
    .eq('id', id);
  if (error) throw error;
}

/** Delete a project. RLS guarantees only the owner can call this. */
export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}
