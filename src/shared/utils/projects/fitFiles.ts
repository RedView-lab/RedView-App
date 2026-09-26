import {
  FIT_FILES_BUCKET_ID,
  ID,
  Permission,
  Role,
  storage,
} from '@/shared/services/appwrite';

import { getCurrentUserId } from './auth';
import type { ItineraryFitUpload } from './types';

export async function uploadProjectItineraryFitFiles(
  _projectId: string,
  _itineraryId: string,
  files: File[],
): Promise<ItineraryFitUpload[]> {
  const userId = await getCurrentUserId();
  const uploads: ItineraryFitUpload[] = [];

  for (const file of files) {
    try {
      const fileId = ID.unique();
      const res = await storage.createFile(
        FIT_FILES_BUCKET_ID,
        fileId,
        file,
        [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(userId)),
          Permission.delete(Role.user(userId)),
        ],
      );

      uploads.push({
        path: res.$id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        lastModified: file.lastModified,
        size: file.size,
      });
    } catch (error) {
      console.warn('[fitFiles] upload failed for file', file.name, error);
    }
  }

  return uploads;
}

export async function deleteProjectItineraryFitFiles(
  _projectId: string,
  _itineraryId: string,
  _knownUserId?: string,
): Promise<void> {
  // No-op or cleanup handled per file ID in deleteProjectFitFiles
}

export interface DownloadedFitFileEntry {
  path: string;
  name: string;
  file: File | null;
  notFound: boolean;
}

export async function downloadProjectItineraryFitFileEntries(
  uploads: ItineraryFitUpload[] | null | undefined,
): Promise<DownloadedFitFileEntry[]> {
  if (!uploads || uploads.length === 0) return [];

  return Promise.all(
    uploads
      .filter((upload) => typeof upload.path === 'string' && upload.path.length > 0)
      .map(async (upload) => {
        const fileId = upload.path as string;
        try {
          const downloadUrl = storage.getFileDownload(FIT_FILES_BUCKET_ID, fileId);
          const res = await fetch(downloadUrl);
          if (!res.ok) {
            console.warn(`[fit-predictor] FIT file ${upload.name} (${fileId}) could not be downloaded (status ${res.status}).`);
            return {
              path: fileId,
              name: upload.name,
              file: null,
              notFound: res.status === 404,
            };
          }
          const blob = await res.blob();
          const file = new File([blob], upload.name, {
            type: upload.type || 'application/octet-stream',
            lastModified: upload.lastModified,
          });
          return {
            path: fileId,
            name: upload.name,
            file,
            notFound: false,
          };
        } catch (err) {
          console.warn(`[fit-predictor] Error fetching FIT file ${upload.name} (${fileId}):`, err);
          return {
            path: fileId,
            name: upload.name,
            file: null,
            notFound: false,
          };
        }
      }),
  );
}

export async function downloadProjectItineraryFitFiles(
  uploads: ItineraryFitUpload[] | null | undefined,
): Promise<File[]> {
  const entries = await downloadProjectItineraryFitFileEntries(uploads);
  return entries.map((entry) => entry.file).filter((file): file is File => file !== null);
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

export async function deleteProjectFitFiles(_projectId: string): Promise<void> {
  // Cleanup will be handled automatically or when removing individual itinerary files
}