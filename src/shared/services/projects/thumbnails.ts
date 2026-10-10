import {
  client,
  getAppwriteUser,
  getSessionUserIdSync,
  Role,
  Permission,
  Query,
  storage,
  THUMBNAILS_BUCKET_ID,
} from '@/shared/services/appwrite';
import { idbSaveThumbnail, idbGetThumbnail } from '@/shared/services/storage/idbProjectStore';

import { isSharedProject, sharedProjectOwner, sharedProjectTeamId } from './liveSessions';

function safeThumbnailFileId(projectId: string): string {
  const sanitized = projectId.replace(/[^a-zA-Z0-9._-]/g, '');
  return sanitized.slice(0, 36) || 'thumbnail';
}

/** Identifiant connu sans aller-retour (comme `getCurrentUserId`), GET /account seulement à défaut. */
async function getAuthenticatedUserId(): Promise<string> {
  const known = getSessionUserIdSync();
  if (known) return known;

  const user = await getAppwriteUser();
  if (user?.$id) return user.$id;

  throw new Error('Not authenticated');
}

export async function uploadProjectThumbnail(projectId: string, blob: Blob): Promise<void> {
  // 1. Toujours enregistrer la miniature dans IndexedDB pour affichage immédiat
  void idbSaveThumbnail(projectId, blob).catch((err) => {
    console.warn('[thumbnails] idbSaveThumbnail error', err);
  });

  try {
    const userId = await getAuthenticatedUserId();
    // Projet partagé : la miniature cloud est celle du propriétaire, lisible par
    // l'équipe ; celle d'un éditeur reste locale (le fichier ne lui appartient pas).
    const shared = isSharedProject(projectId);
    if (shared && sharedProjectOwner(projectId) !== userId) return;
    const teamId = shared ? sharedProjectTeamId(projectId) : null;
    const fileId = safeThumbnailFileId(projectId);
    const mime = blob.type || 'image/webp';
    const ext = mime.includes('webp') ? 'webp' : 'jpg';
    const file = new File([blob], `${fileId}.${ext}`, { type: mime });
    const create = () => storage.createFile(
      THUMBNAILS_BUCKET_ID,
      fileId,
      file,
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
        ...(teamId ? [Permission.read(Role.team(teamId))] : []),
      ],
    );

    // Le contenu d'un fichier Appwrite ne se remplace pas : l'ancienne
    // miniature est supprimée, mais seulement si elle existe (un premier envoi
    // répondait 404 à la suppression). Existence inconnue (liste échouée) :
    // suppression tentée comme avant.
    if (await cloudThumbnailExists(fileId).catch(() => true)) {
      await storage.deleteFile(THUMBNAILS_BUCKET_ID, fileId).catch(() => {});
    }
    knownCloudThumbnails.set(fileId, false);
    try {
      await create();
    } catch (error) {
      // Envoyée entre-temps par un autre onglet / appareil : remplacée.
      if (errorCode(error) !== 409) throw error;
      await storage.deleteFile(THUMBNAILS_BUCKET_ID, fileId);
      await create();
    }
    knownCloudThumbnails.set(fileId, true);
  } catch (error) {
    console.debug('[projects] uploadProjectThumbnail cloud skip (saved locally)', error);
  }
}

function errorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

/**
 * Miniatures cloud dont l'existence est connue (id de fichier → existe) :
 * listes du navigateur de projets, envois et suppressions de cette session.
 * Sert à ne jamais viser un fichier absent (404 en rouge dans la console).
 */
const knownCloudThumbnails = new Map<string, boolean>();

/** La miniature existe-t-elle dans le cloud ? Liste (200) si on ne le sait pas ; une erreur remonte. */
async function cloudThumbnailExists(fileId: string): Promise<boolean> {
  const known = knownCloudThumbnails.get(fileId);
  if (known !== undefined) return known;
  const existing = await listExistingCloudThumbnailIds([fileId]);
  if (!existing) throw new Error('Cloud thumbnail list failed');
  return existing.has(fileId);
}

/** Nombre maximal de téléchargements de miniatures cloud simultanés. */
const THUMBNAIL_FETCH_CONCURRENCY = 6;

/**
 * Télécharge une miniature cloud via le client Appwrite (session cookie +
 * `X-Fallback-Cookies` quand les cookies tiers sont bloqués). Les fichiers ne
 * sont lisibles que par leur propriétaire : un `<img src>` direct vers
 * l'endpoint Appwrite ne transporterait pas forcément ces identifiants.
 */
async function fetchCloudThumbnailBlob(projectId: string): Promise<Blob | null> {
  const fileId = safeThumbnailFileId(projectId);
  const viewUrl = new URL(storage.getFileView(THUMBNAILS_BUCKET_ID, fileId));
  const data: unknown = await client.call('get', viewUrl, {}, {}, 'arrayBuffer');
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return null;
  return new Blob([data], { type: sniffImageMime(new Uint8Array(data, 0, Math.min(12, data.byteLength))) });
}

function sniffImageMime(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  // Miniatures RedView : WebP par défaut (cf. uploadProjectThumbnail).
  return 'image/webp';
}

/** Limite Appwrite du nombre de valeurs dans un `Query.equal`. */
const THUMBNAIL_LIST_CHUNK = 100;

/**
 * IDs de fichiers miniatures existants (et lisibles par l'utilisateur) parmi
 * `fileIds`. Un seul `listFiles` par lot de 100 au lieu d'un GET par projet :
 * les projets sans miniature cloud ne génèrent plus de 404 dans la console.
 * Renvoie null si la liste échoue (on retente alors fichier par fichier).
 */
async function listExistingCloudThumbnailIds(fileIds: string[]): Promise<Set<string> | null> {
  const existing = new Set<string>();
  try {
    for (let i = 0; i < fileIds.length; i += THUMBNAIL_LIST_CHUNK) {
      const chunk = fileIds.slice(i, i + THUMBNAIL_LIST_CHUNK);
      const res = await storage.listFiles(THUMBNAILS_BUCKET_ID, [
        Query.equal('$id', chunk),
        Query.limit(chunk.length),
      ]);
      for (const file of res.files) existing.add(file.$id);
      for (const id of chunk) knownCloudThumbnails.set(id, existing.has(id));
    }
    return existing;
  } catch (error) {
    console.debug('[thumbnails] listFiles failed, falling back to per-file fetch', error);
    return null;
  }
}

/**
 * Miniature d'un projet : IndexedDB d'abord (instantané, hors-ligne), puis
 * cloud. `cloudIds` : miniatures cloud existantes déjà listées (null : liste
 * échouée, téléchargement tenté) ; sans elles, l'existence est vérifiée avant
 * de télécharger (un projet sans miniature répondait 404).
 */
export async function loadProjectThumbnailBlob(
  projectId: string,
  cloudIds?: Set<string> | null,
): Promise<Blob | null> {
  try {
    const localBlob = await idbGetThumbnail(projectId);
    if (localBlob) return localBlob;
  } catch {
    // continuer vers le cloud
  }

  if (projectId.startsWith('local-')) return null;
  const fileId = safeThumbnailFileId(projectId);
  const exists = cloudIds === undefined
    ? await cloudThumbnailExists(fileId).catch(() => true)
    : cloudIds === null || cloudIds.has(fileId);
  if (!exists) return null;

  try {
    const cloudBlob = await fetchCloudThumbnailBlob(projectId);
    if (cloudBlob) {
      void idbSaveThumbnail(projectId, cloudBlob).catch(() => {});
    }
    return cloudBlob;
  } catch {
    return null;
  }
}

/**
 * Renvoie une URL `blob:` par projet (ou null). L'appelant est propriétaire de
 * ces URLs et doit les libérer avec `URL.revokeObjectURL` quand elles ne sont
 * plus affichées.
 */
export async function getProjectThumbnailUrls(
  projectIds: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (projectIds.length === 0) return out;

  const cloudFileIds = [
    ...new Set(projectIds.filter((id) => !id.startsWith('local-')).map(safeThumbnailFileId)),
  ];
  const cloudIds = cloudFileIds.length > 0 ? await listExistingCloudThumbnailIds(cloudFileIds) : null;

  let cursor = 0;
  const worker = async () => {
    while (cursor < projectIds.length) {
      const id = projectIds[cursor++];
      const blob = await loadProjectThumbnailBlob(id, cloudIds);
      out[id] = blob ? URL.createObjectURL(blob) : null;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(THUMBNAIL_FETCH_CONCURRENCY, projectIds.length) }, worker),
  );

  return out;
}

export async function duplicateProjectThumbnail(
  sourceProjectId: string,
  targetProjectId: string,
): Promise<boolean> {
  try {
    const blob = await loadProjectThumbnailBlob(sourceProjectId);
    if (!blob) return false;
    await uploadProjectThumbnail(targetProjectId, blob);
    return true;
  } catch {
    return false;
  }
}

export async function deleteProjectThumbnail(projectId: string): Promise<void> {
  if (projectId.startsWith('local-')) return;
  const fileId = safeThumbnailFileId(projectId);
  try {
    // Projet sans miniature cloud : rien à supprimer (la suppression répondait 404).
    if (!(await cloudThumbnailExists(fileId))) return;
    await storage.deleteFile(THUMBNAILS_BUCKET_ID, fileId);
    knownCloudThumbnails.set(fileId, false);
  } catch (error) {
    if (errorCode(error) === 404) {
      knownCloudThumbnails.set(fileId, false);
      return;
    }
    console.warn('[projects] deleteProjectThumbnail failed', error);
  }
}