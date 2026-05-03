import { getSupabaseUser, readStoredSupabaseSession, supabase } from '@/shared/services/supabase';

const THUMBNAIL_BUCKET = 'project-thumbnails';
const THUMBNAIL_SIGNED_URL_TTL = 60 * 60;
const THUMBNAIL_EXTENSIONS = ['jpg', 'png'] as const;

function thumbnailPath(
  userId: string,
  projectId: string,
  extension: (typeof THUMBNAIL_EXTENSIONS)[number] = 'jpg',
): string {
  return `${userId}/${projectId}.${extension}`;
}

async function getAuthenticatedUserId(): Promise<string> {
  const storedSession = readStoredSupabaseSession();
  if (storedSession?.user.id) return storedSession.user.id;

  const user = await getSupabaseUser();
  if (!user) throw new Error('Not authenticated');
  return user.id;
}

export async function uploadProjectThumbnail(projectId: string, blob: Blob): Promise<void> {
  const userId = await getAuthenticatedUserId();

  const { error } = await supabase.storage.from(THUMBNAIL_BUCKET).upload(thumbnailPath(userId, projectId, 'jpg'), blob, {
    contentType: 'image/jpeg',
    upsert: true,
    cacheControl: '86400',
  });
  if (error) throw error;
}

export async function getProjectThumbnailUrls(
  projectIds: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (projectIds.length === 0) return out;

  const userId = await getAuthenticatedUserId();

  const requests = projectIds.flatMap((projectId) =>
    THUMBNAIL_EXTENSIONS.map((extension) => ({
      projectId,
      path: thumbnailPath(userId, projectId, extension),
    })),
  );
  const { data, error } = await supabase.storage
    .from(THUMBNAIL_BUCKET)
    .createSignedUrls(
      requests.map((entry) => entry.path),
      THUMBNAIL_SIGNED_URL_TTL,
    );

  for (const id of projectIds) out[id] = null;

  if (error) {
    console.warn('[projects] createSignedUrls failed', error);
    return out;
  }

  for (const [index, entry] of (data ?? []).entries()) {
    const request = requests[index];
    if (!request || out[request.projectId] || !entry?.path || entry.error || !entry.signedUrl) continue;
    out[request.projectId] = entry.signedUrl;
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

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error('Impossible de copier la miniature du projet.');
  }

  const blob = await response.blob();
  await uploadProjectThumbnail(targetProjectId, blob);
  return true;
}

export async function deleteProjectThumbnail(projectId: string): Promise<void> {
  try {
    const userId = await getAuthenticatedUserId();
    await supabase.storage
      .from(THUMBNAIL_BUCKET)
      .remove(THUMBNAIL_EXTENSIONS.map((extension) => thumbnailPath(userId, projectId, extension)));
  } catch (error) {
    console.warn('[projects] deleteProjectThumbnail failed', error);
  }
}