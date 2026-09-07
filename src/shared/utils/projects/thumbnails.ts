import {
  getAppwriteUser,
  readStoredAppwriteSession,
  Role,
  Permission,
  storage,
  THUMBNAILS_BUCKET_ID,
} from '@/shared/services/appwrite';

function safeThumbnailFileId(projectId: string): string {
  const sanitized = projectId.replace(/[^a-zA-Z0-9._-]/g, '');
  return sanitized.slice(0, 36) || 'thumbnail';
}

async function getAuthenticatedUserId(): Promise<string> {
  const storedSession = readStoredAppwriteSession();
  if (storedSession?.user.id) return storedSession.user.id;

  const user = await getAppwriteUser();
  if (!user) throw new Error('Not authenticated');
  return user.$id;
}

export async function uploadProjectThumbnail(projectId: string, blob: Blob): Promise<void> {
  const userId = await getAuthenticatedUserId();
  const fileId = safeThumbnailFileId(projectId);
  const file = new File([blob], `${fileId}.jpg`, { type: 'image/jpeg' });

  try {
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
    console.warn('[projects] uploadProjectThumbnail error', error);
  }
}

export async function getProjectThumbnailUrls(
  projectIds: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (projectIds.length === 0) return out;

  for (const id of projectIds) {
    try {
      const fileId = safeThumbnailFileId(id);
      const url = storage.getFileView(THUMBNAILS_BUCKET_ID, fileId);
      out[id] = url.toString();
    } catch {
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