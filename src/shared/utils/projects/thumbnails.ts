import {
  getAppwriteUser,
  readStoredAppwriteSession,
  Role,
  Permission,
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
        Permission.read(Role.any()),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
      ],
    );
  } catch (error) {
    console.debug('[projects] uploadProjectThumbnail cloud skip (saved locally)', error);
  }
}

export async function getProjectThumbnailUrls(
  projectIds: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (projectIds.length === 0) return out;

  for (const id of projectIds) {
    // 1. Toujours vérifier IndexedDB en premier : affichage instantané (0 ms, hors-ligne, fiable sur Firefox & Chrome)
    try {
      const localBlob = await idbGetThumbnail(id);
      if (localBlob) {
        out[id] = URL.createObjectURL(localBlob);
        continue;
      }
    } catch {
      // continuer vers le cloud
    }

    // 2. URL cloud directe via getFileView : sert le WebP/JPEG pré-compressé sans bug 0-octet de preview Appwrite
    if (!id.startsWith('local-')) {
      try {
        const fileId = safeThumbnailFileId(id);
        const url = storage.getFileView(THUMBNAILS_BUCKET_ID, fileId);
        out[id] = url.toString();
      } catch {
        out[id] = null;
      }
    } else {
      out[id] = null;
    }
  }

  return out;
}

export async function duplicateProjectThumbnail(
  sourceProjectId: string,
  targetProjectId: string,
): Promise<boolean> {
  const urls = await getProjectThumbnailUrls([sourceProjectId]);
  const sourceUrl = urls[sourceProjectId];
  if (!sourceUrl) return false;

  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      return false;
    }
    const blob = await response.blob();
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