import {
  FIT_FILES_BUCKET_ID,
  ID,
  Permission,
  client,
  Role,
  storage,
} from '@/shared/services/appwrite';

import { getCurrentUserId } from './auth';
import { isLiveSession, sharedProjectTeamId } from './liveSessions';
import type { ItineraryFitUpload } from './types';

export interface FitUploadBatchResult {
  /** Fichiers enregistrés dans le bucket, dans l'ordre d'entrée. */
  uploads: ItineraryFitUpload[];
  /** Fichiers dont l'envoi a échoué (à signaler, à garder en local). */
  failed: File[];
}

export async function uploadProjectItineraryFitFiles(
  projectId: string,
  _itineraryId: string,
  files: File[],
): Promise<FitUploadBatchResult> {
  const userId = await getCurrentUserId();
  // Projet en co-édition : les autres éditeurs lisent aussi ce fichier (prédiction).
  const teamId = isLiveSession(projectId) ? sharedProjectTeamId(projectId) : null;
  const uploads: ItineraryFitUpload[] = [];
  const failed: File[] = [];

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
          ...(teamId ? [Permission.read(Role.team(teamId))] : []),
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
      failed.push(file);
    }
  }

  return { uploads, failed };
}

/**
 * Supprime du bucket les fichiers FIT donnés (traces GPS personnelles : RGPD).
 * Les uploads hérités (base64 dans le projet, sans `path`) sont ignorés. Un
 * fichier déjà absent (404) compte comme supprimé. Renvoie les ids non
 * supprimés.
 */
export async function deleteFitUploads(
  uploads: readonly ItineraryFitUpload[] | null | undefined,
): Promise<string[]> {
  const ids = (uploads ?? [])
    .map((upload) => upload.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  const results = await Promise.allSettled(
    ids.map((id) => storage.deleteFile(FIT_FILES_BUCKET_ID, id)),
  );
  const failedIds: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const code = (result.reason as { code?: number } | null)?.code;
    if (code === 404) return;
    console.warn('[fitFiles] delete failed for file', ids[index], result.reason);
    failedIds.push(ids[index]!);
  });
  return failedIds;
}

// TODO(rgpd) : suppression d'un itinéraire / d'un projet. Ces deux points
// d'entrée ne reçoivent que des ids, or les fichiers du bucket ne sont pas
// rattachés au projet (id unique, sans métadonnée) : il faudrait passer les
// `fitUploads` des itinéraires supprimés (ItineraryPanelContainer, effet sur
// les ids retirés ; useProjectBrowserProjects.handleDelete / rollback de la
// duplication, qui devraient charger les données du projet) puis appeler
// deleteFitUploads. Laissé en l'état pendant la refonte de projectRows.ts.
export async function deleteProjectItineraryFitFiles(
  _projectId: string,
  _itineraryId: string,
  _knownUserId?: string,
): Promise<void> {
  // Voir TODO(rgpd) ci-dessus.
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
          // Via le client Appwrite (session cookie + `X-Fallback-Cookies`) : un
          // `fetch` nu partait sans session, Appwrite répondait 404 sur ces
          // fichiers lisibles par leur seul propriétaire, et l'hydratation les
          // retirait du projet comme supprimés.
          const downloadUrl = new URL(storage.getFileDownload(FIT_FILES_BUCKET_ID, fileId));
          const data: unknown = await client.call('get', downloadUrl, {}, {}, 'arrayBuffer');
          if (!(data instanceof ArrayBuffer)) {
            throw new Error('Unexpected FIT download response');
          }
          const file = new File([data], upload.name, {
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
          const code = (err as { code?: number } | null)?.code;
          console.warn(`[fit-predictor] FIT file ${upload.name} (${fileId}) could not be downloaded (status ${code ?? 'network'}).`, err);
          return {
            path: fileId,
            name: upload.name,
            file: null,
            notFound: code === 404,
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
    if (files.length === 0) {
      // Jamais de fichiers partagés entre deux projets : retirer un .fit de la
      // copie le supprime du bucket (deleteFitUploads) et l'ôterait à l'original.
      uploadsByItineraryId[itinerary.id] = [];
      continue;
    }

    const { uploads, failed } = await uploadProjectItineraryFitFiles(
      targetProjectId,
      itinerary.id,
      files,
    );
    if (failed.length > 0) {
      console.warn(`[fitFiles] duplicate: ${failed.length} FIT file(s) could not be copied`, failed.map((file) => file.name));
    }
    uploadsByItineraryId[itinerary.id] = uploads;
  }

  return uploadsByItineraryId;
}

export async function deleteProjectFitFiles(_projectId: string): Promise<void> {
  // Voir TODO(rgpd) près de deleteProjectItineraryFitFiles : sans les
  // fitUploads du projet, les fichiers ne peuvent pas être retrouvés.
}