import { supabase } from '@/shared/services/supabase';

const THUMBNAIL_BUCKET = 'project-thumbnails';
const THUMBNAIL_SIGNED_URL_TTL = 60 * 60;

function thumbnailPath(userId: string, projectId: string): string {
  return `${userId}/${projectId}.png`;
}

export async function uploadProjectThumbnail(projectId: string, blob: Blob): Promise<void> {
  const { data: sessionData, error: sessionErr } = await supabase.auth.getUser();
  if (sessionErr) throw sessionErr;
  const user = sessionData.user;
  if (!user) throw new Error('Not authenticated');

  const { error } = await supabase.storage.from(THUMBNAIL_BUCKET).upload(thumbnailPath(user.id, projectId), blob, {
    contentType: 'image/png',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) throw error;
}

export async function getProjectThumbnailUrls(
  projectIds: string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (projectIds.length === 0) return out;

  const { data: sessionData, error: sessionErr } = await supabase.auth.getUser();
  if (sessionErr) throw sessionErr;
  const user = sessionData.user;
  if (!user) throw new Error('Not authenticated');

  const paths = projectIds.map((id) => thumbnailPath(user.id, id));
  const { data, error } = await supabase.storage
    .from(THUMBNAIL_BUCKET)
    .createSignedUrls(paths, THUMBNAIL_SIGNED_URL_TTL);

  for (const id of projectIds) out[id] = null;

  if (error) {
    console.warn('[projects] createSignedUrls failed', error);
    return out;
  }

  for (const entry of data ?? []) {
    if (!entry.path || entry.error || !entry.signedUrl) continue;
    const segs = entry.path.split('/');
    const file = segs[segs.length - 1] ?? '';
    const id = file.replace(/\.png$/, '');
    if (id) out[id] = entry.signedUrl;
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
    const { data: sessionData } = await supabase.auth.getUser();
    const user = sessionData.user;
    if (!user) return;
    await supabase.storage.from(THUMBNAIL_BUCKET).remove([thumbnailPath(user.id, projectId)]);
  } catch (error) {
    console.warn('[projects] deleteProjectThumbnail failed', error);
  }
}