import { createDefaultProject } from '@/features/itineraryPanel/lib/project';
import { supabase } from '@/shared/services/supabase';

import { getCurrentUserId } from './auth';
import { rowToSummary } from './mappers';
import type { ItineraryProject, ProjectRow, ProjectSummary } from './types';

function computeSizeBytes(data: ItineraryProject): number {
  try {
    return new Blob([JSON.stringify(data)]).size;
  } catch {
    return 0;
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, folder_id, name, privacy, size_bytes, created_at, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => rowToSummary(row as ProjectRow));
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ProjectRow | null) ?? null;
}

export async function createProject(
  name?: string,
  initialData?: ItineraryProject,
  folderId?: string | null,
): Promise<ProjectRow> {
  const userId = await getCurrentUserId();
  const baseProject: ItineraryProject = initialData ?? createDefaultProject();
  const finalProject: ItineraryProject = name ? { ...baseProject, name } : baseProject;

  const { data, error } = await supabase
    .from('projects')
    .insert({
      user_id: userId,
      folder_id: folderId ?? null,
      name: finalProject.name,
      data: finalProject,
      size_bytes: computeSizeBytes(finalProject),
      privacy: finalProject.privacy ?? 'private',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ProjectRow;
}

export async function saveProject(id: string, project: ItineraryProject): Promise<void> {
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

export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name cannot be empty');

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

export async function moveProjectToFolder(
  id: string,
  folderId: string | null,
): Promise<void> {
  const { error } = await supabase.from('projects').update({ folder_id: folderId }).eq('id', id);
  if (error) throw error;
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}