import {
  client,
  getAppwriteUser,
  readStoredAppwriteSession,
  Role,
  Permission,
  Query,
  storage,
  THUMBNAILS_BUCKET_ID,
} from '@/shared/services/appwrite';
import { idbSaveThumbnail, idbGetThumbnail } from '@/shared/utils/storage/idbProjectStore';

function safeThumbnailFileId(projectId: string): string {
  const sanitized = projectId.replace(/[^a-zA-Z0-9._-]/g, '');
  return sanitized.slice(0, 36) || 'thumbnail';
}

async function getAuthenticatedUserId(): Promise<string> {
  const user = await getAppwriteUser();
  if (user?.$id) return user.$id;

  const storedSession = readStoredAppwriteSession();
  if (storedSession?.user.id) return storedSession.user.id;

  throw new Error('Not authenticated');
}

export async function uploadProjectThumbnail(projectId: string, blob: Blob): Promise<void> {
  // 1. Toujours enregistrer la miniature dans IndexedDB pour affichage immédiat
  void idbSaveThumbnail(projectId, blob).catch((err) => {
    console.warn('[thumbnails] idbSaveThumbnail error', err);
  });

  try {
    const userId = await getAuthenticatedUserId();
    const fileId = safeThumbnailFileId(projectId);
    const mime = blob.type || 'image/webp';
    const ext = mime.includes('webp') ? 'webp' : 'jpg';
    const file = new File([blob], `${fileId}.${ext}`, { type: mime });

    await storage.deleteFile(THUMBNAILS_BUCKET_ID, fileId).catch(() => {});
    await storage.createFile(
      THUMBNAILS_BUCKET_ID,
      fileId,
      file,
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
      ],
    );
  } catch (error) {
    console.debug('[projects] uploadProjectThumbnail cloud skip (saved locally)', error);
  }
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
    }
    return existing;
  } catch (error) {
    console.debug('[thumbnails] listFiles failed, falling back to per-file fetch', error);
    return null;
  }
}

/** Miniature d'un projet : IndexedDB d'abord (instantané, hors-ligne), puis cloud. */
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
  if (cloudIds && !cloudIds.has(safeThumbnailFileId(projectId))) return null;

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
  try {
    const fileId = safeThumbnailFileId(projectId);
    await storage.deleteFile(THUMBNAILS_BUCKET_ID, fileId);
  } catch (error) {
    console.warn('[projects] deleteProjectThumbnail failed', error);
  }
}