import {
  FIT_FILES_BUCKET_ID,
  ID,
  Permission,
  Query,
  client,
  Role,
  storage,
} from '@/shared/services/appwrite';

import { getCurrentUserId } from './auth';
import { isLiveSession, sharedProjectTeamId } from './liveSessions';
import type { ItineraryFitUpload, ItineraryProject } from './types';

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

const OWNED_FILES_PAGE_SIZE = 100;
const OWNED_FILES_MAX_PAGES = 200;

/** Le compte possède le fichier : ses permissions lui donnent la modification ou la suppression (comme la purge serveur). */
export function isFitFileOwnedBy(permissions: readonly string[] | undefined, userId: string): boolean {
  const role = `user:${userId}`;
  return Array.isArray(permissions)
    && (permissions.includes(`update("${role}")`) || permissions.includes(`delete("${role}")`));
}

/**
 * Efface tous les fichiers FIT dont le compte connecté est propriétaire, y
 * compris ceux qu'aucun projet ne référence plus (retrait du consentement aux
 * données de santé). Les fichiers d'autres éditeurs, lisibles dans un projet
 * partagé, ne sont pas touchés. Les références restées dans les projets sont
 * tolérées : un fichier absent est signalé et ignoré par l'hydratation.
 * Renvoie le nombre de fichiers effacés et ceux qui ont échoué.
 */
export async function deleteOwnedFitFiles(): Promise<{ deleted: number; failed: number }> {
  const userId = await getCurrentUserId();
  if (!userId) throw new Error('Session utilisateur introuvable.');
  const owned: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < OWNED_FILES_MAX_PAGES; page += 1) {
    const list: { files: Array<{ $id: string; $permissions: string[] }> } = await storage.listFiles(FIT_FILES_BUCKET_ID, [
      Query.limit(OWNED_FILES_PAGE_SIZE),
      ...(cursor ? [Query.cursorAfter(cursor)] : []),
    ]);
    for (const file of list.files) if (isFitFileOwnedBy(file.$permissions, userId)) owned.push(file.$id);
    if (list.files.length < OWNED_FILES_PAGE_SIZE) break;
    cursor = list.files[list.files.length - 1]!.$id;
  }
  const failed = await deleteFitUploads(owned.map((path) => ({ path }) as ItineraryFitUpload));
  return { deleted: owned.length - failed.length, failed: failed.length };
}

/**
 * Fichiers FIT du bucket référencés par un projet (tous ses itinéraires). Les
 * fichiers ne portent aucune métadonnée de projet : c'est le document qui dit
 * lesquels lui appartiennent (un fichier n'est jamais partagé entre deux
 * projets, voir duplicateProjectItineraryFitFiles).
 */
export function collectProjectFitUploads(
  project: Pick<ItineraryProject, 'itineraries'> | null | undefined,
): ItineraryFitUpload[] {
  return (project?.itineraries ?? []).flatMap((itinerary) =>
    (itinerary.fitUploads ?? []).filter((upload) => typeof upload.path === 'string' && upload.path.length > 0),
  );
}

/**
 * Fichiers des itinéraires supprimés, par projet, en attente d'effacement. La
 * suppression d'un itinéraire s'annule (historique de tracé) : effacer ses
 * fichiers tout de suite casserait l'annulation. Ils sont effacés à la
 * fermeture du projet, s'il ne les référence plus (flushPendingFitDeletions).
 */
const pendingFitDeletions = new Map<string, Map<string, ItineraryFitUpload>>();

export function scheduleFitUploadsDeletion(projectId: string, uploads: readonly ItineraryFitUpload[]): void {
  const withPath = uploads.filter((upload) => typeof upload.path === 'string' && upload.path.length > 0);
  if (withPath.length === 0) return;
  const pending = pendingFitDeletions.get(projectId) ?? new Map<string, ItineraryFitUpload>();
  for (const upload of withPath) pending.set(upload.path as string, upload);
  pendingFitDeletions.set(projectId, pending);
}

/**
 * Efface les fichiers en attente du projet que `project` (son état courant) ne
 * référence plus ; ceux qu'une annulation a rendus au projet sont gardés.
 * Renvoie le nombre de fichiers effacés.
 */
export async function flushPendingFitDeletions(
  projectId: string,
  project: Pick<ItineraryProject, 'itineraries'> | null | undefined,
): Promise<number> {
  const pending = pendingFitDeletions.get(projectId);
  pendingFitDeletions.delete(projectId);
  if (!pending || pending.size === 0) return 0;
  const referenced = new Set(collectProjectFitUploads(project).map((upload) => upload.path));
  const orphans = [...pending.values()].filter((upload) => !referenced.has(upload.path));
  const failed = await deleteFitUploads(orphans);
  return orphans.length - failed.length;
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

