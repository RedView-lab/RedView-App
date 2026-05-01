import { supabase } from '@/shared/services/supabase';

import { getCurrentUserId } from './auth';
import type { ItineraryFitUpload } from './types';

const FIT_BUCKET = 'itinerary-fit-files';

function fitProjectFolderPath(userId: string, projectId: string): string {
  return `${userId}/${projectId}`;
}

function sanitizeFitFileName(fileName: string): string {
  const trimmed = fileName.trim() || 'activity.fit';
  const sanitized = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const withExtension = /\.fit$/i.test(sanitized) ? sanitized : `${sanitized || 'activity'}.fit`;
  return withExtension.toLowerCase();
}

function fitObjectName(itineraryId: string, index: number, fileName: string): string {
  const safeItineraryId = itineraryId.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return `${safeItineraryId}--${String(index).padStart(2, '0')}--${sanitizeFitFileName(fileName)}`;
}

function fitObjectPath(
  userId: string,
  projectId: string,
  itineraryId: string,
  index: number,
  fileName: string,
): string {
  return `${fitProjectFolderPath(userId, projectId)}/${fitObjectName(itineraryId, index, fileName)}`;
}

async function listProjectFitObjectPaths(userId: string, projectId: string): Promise<string[]> {
  const folder = fitProjectFolderPath(userId, projectId);
  const { data, error } = await supabase.storage.from(FIT_BUCKET).list(folder, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) {
    const message = String(error.message ?? '');
    if (/not found|does not exist/i.test(message)) return [];
    throw error;
  }
  return (data ?? [])
    .filter((entry) => !entry.id || entry.name.toLowerCase().endsWith('.fit'))
    .map((entry) => `${folder}/${entry.name}`);
}

export async function uploadProjectItineraryFitFiles(
  projectId: string,
  itineraryId: string,
  files: File[],
): Promise<ItineraryFitUpload[]> {
  const userId = await getCurrentUserId();
  await deleteProjectItineraryFitFiles(projectId, itineraryId, userId);

  const uploads: ItineraryFitUpload[] = [];
  for (const [index, file] of files.entries()) {
    const path = fitObjectPath(userId, projectId, itineraryId, index, file.name);
    const { error } = await supabase.storage.from(FIT_BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      cacheControl: '3600',
      upsert: true,
    });
    if (error) throw error;
    uploads.push({
      path,
      name: file.name,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      size: file.size,
    });
  }

  return uploads;
}

export async function deleteProjectItineraryFitFiles(
  projectId: string,
  itineraryId: string,
  knownUserId?: string,
): Promise<void> {
  const userId = knownUserId ?? (await getCurrentUserId());
  const existingPaths = await listProjectFitObjectPaths(userId, projectId);
  const itineraryPrefix = `${fitProjectFolderPath(userId, projectId)}/${itineraryId.replace(/[^a-zA-Z0-9_-]+/g, '_')}--`;
  const pathsToDelete = existingPaths.filter((path) => path.startsWith(itineraryPrefix));
  if (pathsToDelete.length === 0) return;
  const { error } = await supabase.storage.from(FIT_BUCKET).remove(pathsToDelete);
  if (error) throw error;
}

export async function downloadProjectItineraryFitFiles(
  uploads: ItineraryFitUpload[] | null | undefined,
): Promise<File[]> {
  if (!uploads || uploads.length === 0) return [];
  return Promise.all(
    uploads
      .filter((upload) => typeof upload.path === 'string' && upload.path.length > 0)
      .map(async (upload) => {
        const { data, error } = await supabase.storage.from(FIT_BUCKET).download(upload.path as string);
        if (error) throw error;
        return new File([data], upload.name, {
          type: upload.type || 'application/octet-stream',
          lastModified: upload.lastModified,
        });
      }),
  );
}

export async function duplicateProjectItineraryFitFiles(
  sourceItineraries: Array<{ id: string; fitUploads?: ItineraryFitUpload[] | null }>,
  targetProjectId: string,
): Promise<Record<string, ItineraryFitUpload[]>> {
  const uploadsByItineraryId: Record<string, ItineraryFitUpload[]> = {};

  for (const itinerary of sourceItineraries) {
    const sourceUploads = itinerary.fitUploads?.filter(
      (upload) => typeof upload.path === 'string' && upload.path.length > 0,
    );
    if (!sourceUploads || sourceUploads.length === 0) continue;

    const files = await downloadProjectItineraryFitFiles(sourceUploads);
    if (files.length === 0) continue;

    uploadsByItineraryId[itinerary.id] = await uploadProjectItineraryFitFiles(
      targetProjectId,
      itinerary.id,
      files,
    );
  }

  return uploadsByItineraryId;
}

export async function deleteProjectFitFiles(projectId: string): Promise<void> {
  try {
    const userId = await getCurrentUserId();
    const paths = await listProjectFitObjectPaths(userId, projectId);
    if (paths.length === 0) return;
    await supabase.storage.from(FIT_BUCKET).remove(paths);
  } catch (error) {
    console.warn('[projects] deleteProjectFitFiles failed', error);
  }
}