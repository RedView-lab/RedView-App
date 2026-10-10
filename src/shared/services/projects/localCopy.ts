import { logger } from '@/shared/lib/logger';
import {
  idbGetProjectMeta,
  idbSaveProject,
  idbUpdateProjectMeta,
} from '@/shared/services/storage/idbProjectStore';
import { getCurrentUserId, isLocalFallbackUser, isOwnedBy } from './auth';
import { utf8ByteLength } from './limits';
import { isServerOwnedDocument } from './liveSessions';
import { enqueue, knownCloudVersions, localQueues, localRevisions, localWriteStamps } from './projectSession';
import { serializeProjectForStorage, type SerializedProject } from './storedProject';
import type { ItineraryProject, ProjectRow } from './types';

// Copie locale IndexedDB d'un projet (document + travail en attente sur cet
// appareil) : écrite avant tout appel réseau, marquée propre seulement après
// confirmation cloud.

/**
 * Projets dont la dernière copie locale a échoué (stockage de l'origine plein —
 * les tuiles LiDAR d'OPFS partagent son quota —, IndexedDB indisponible) :
 * tant que le cloud n'a pas confirmé, leurs modifications n'existent qu'en
 * mémoire (useDashboardProjectSync le signale et retient la fermeture).
 */
const failingLocalCopies = new Set<string>();

export function isLocalCopyFailing(id: string): boolean {
  return failingLocalCopies.has(id);
}

/**
 * Écrit la copie locale d'un projet (IndexedDB), sans réseau. Conserve dossier,
 * date de création et version cloud de base de la ligne existante. Renvoie la
 * révision locale écrite.
 */
export function writeLocalCopy(
  id: string,
  project: ItineraryProject,
  userId: string,
  serialized: SerializedProject,
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
      // Document écrit par le serveur temps réel : jamais à resynchroniser.
      dirty: dirty && !isServerOwnedDocument(id),
      cloud_updated_at: owned?.cloud_updated_at ?? knownCloudVersions.get(id) ?? null,
      // Projet partagé : l'équipe reste connue hors ligne (ouverture en session).
      team_id: owned?.team_id ?? null,
    };
    try {
      await idbSaveProject(row, serialized);
    } catch (error) {
      failingLocalCopies.add(id);
      throw error;
    }
    failingLocalCopies.delete(id);
    localWriteStamps.set(id, now);
    return revision;
  });
}

/**
 * Après confirmation cloud : nouvelle version de base, et propre si aucune
 * écriture locale plus récente. Une copie réécrite depuis par un autre onglet
 * (même IndexedDB) n'est pas touchée : son document n'est pas celui que le
 * cloud vient de confirmer, et lui donner cette version de base ferait passer
 * ses modifications par-dessus celles-ci sans conflit (B3-2).
 */
export function markLocalSynced(id: string, revision: number, cloudUpdatedAt: string): Promise<void> {
  return enqueue(localQueues, id, async () => {
    await idbUpdateProjectMeta(id, (meta) => {
      if (meta.updated_at !== localWriteStamps.get(id)) return {};
      return {
        cloud_updated_at: cloudUpdatedAt,
        dirty: localRevisions.get(id) === revision ? false : meta.dirty,
      };
    });
  }).catch((error: unknown) => {
    logger.projects.warn('IndexedDB markLocalSynced failed', error);
  });
}

/**
 * Sauvegarde uniquement locale (IndexedDB, ligne marquée `dirty`) : utilisée à
 * la fermeture / mise en arrière-plan de l'onglet, quand la requête cloud n'a
 * pas le temps d'aboutir. La ligne sera resynchronisée à la prochaine ouverture.
 * Projet partagé ou en co-édition (`isServerOwnedDocument`) : jamais `dirty`,
 * le serveur temps réel écrit le document (une copie resynchronisée l'écraserait).
 */
export async function saveProjectLocally(
  id: string,
  project: ItineraryProject,
  serialized?: SerializedProject,
): Promise<void> {
  const userId = await getCurrentUserId();
  const stored = serialized ?? serializeProjectForStorage(project);
  const localOnly = isLocalFallbackUser(userId) || id.startsWith('local-') || isServerOwnedDocument(id);
  await writeLocalCopy(id, project, userId, stored, utf8ByteLength(stored.documentJson), !localOnly);
}
