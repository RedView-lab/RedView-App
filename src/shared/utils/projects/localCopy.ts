import { logger } from '@/shared/lib/logger';
import {
  idbGetProjectMeta,
  idbSaveProject,
  idbUpdateProjectMeta,
} from '@/shared/utils/storage/idbProjectStore';
import { getCurrentUserId, isLocalFallbackUser, isOwnedBy } from './auth';
import { utf8ByteLength } from './limits';
import { enqueue, knownCloudVersions, localQueues, localRevisions } from './projectSession';
import type { ItineraryProject, ProjectRow } from './types';

// Copie locale IndexedDB d'un projet : écrite avant tout appel réseau,
// marquée propre seulement après confirmation cloud.

/**
 * Écrit la copie locale d'un projet (IndexedDB), sans réseau. Conserve dossier,
 * date de création et version cloud de base de la ligne existante. Renvoie la
 * révision locale écrite.
 */
export function writeLocalCopy(
  id: string,
  project: ItineraryProject,
  userId: string,
  json: string,
  sizeBytes: number,
  dirty: boolean,
): Promise<number> {
  const revision = (localRevisions.get(id) ?? 0) + 1;
  localRevisions.set(id, revision);
  return enqueue(localQueues, id, async () => {
    const existing = await idbGetProjectMeta(id).catch(() => null);
    const owned = existing && isOwnedBy(existing, userId) ? existing : null;
    const now = new Date().toISOString();
    const row: ProjectRow = {
      id,
      user_id: userId,
      folder_id: owned?.folder_id ?? null,
      name: project.name,
      data: project,
      size_bytes: sizeBytes,
      privacy: project.privacy ?? 'private',
      created_at: owned?.created_at ?? now,
      updated_at: now,
      dirty,
      cloud_updated_at: owned?.cloud_updated_at ?? knownCloudVersions.get(id) ?? null,
    };
    await idbSaveProject(row, json);
    return revision;
  });
}

/** Après confirmation cloud : nouvelle version de base, et propre si aucune écriture locale plus récente. */
export function markLocalSynced(id: string, revision: number, cloudUpdatedAt: string): Promise<void> {
  return enqueue(localQueues, id, async () => {
    await idbUpdateProjectMeta(id, (meta) => ({
      cloud_updated_at: cloudUpdatedAt,
      dirty: localRevisions.get(id) === revision ? false : meta.dirty,
    }));
  }).catch((error: unknown) => {
    logger.projects.warn('IndexedDB markLocalSynced failed', error);
  });
}

/**
 * Sauvegarde uniquement locale (IndexedDB, ligne marquée `dirty`) : utilisée à
 * la fermeture / mise en arrière-plan de l'onglet, quand la requête cloud n'a
 * pas le temps d'aboutir. La ligne sera resynchronisée à la prochaine ouverture.
 */
export async function saveProjectLocally(
  id: string,
  project: ItineraryProject,
  serialized?: string,
): Promise<void> {
  const userId = await getCurrentUserId();
  const json = serialized ?? JSON.stringify(project);
  const localOnly = isLocalFallbackUser(userId) || id.startsWith('local-');
  await writeLocalCopy(id, project, userId, json, utf8ByteLength(json), !localOnly);
}
