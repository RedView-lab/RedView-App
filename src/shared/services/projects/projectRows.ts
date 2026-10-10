/**
 * Persistance des projets : copie locale IndexedDB + document Appwrite.
 *
 * Le document Appwrite (`projects.data`) ne porte que le document partagé du
 * projet (`schema: 2`, cf. lib/project/layers.ts) ; la vue de l'utilisateur
 * est stockée à part (projectViews.ts) et le travail en attente reste dans la
 * copie locale. `ProjectRow.data` est toujours le projet composé.
 *
 * Invariants :
 *  - Toute sauvegarde écrit d'abord la copie locale (marquée `dirty`) avant
 *    tout appel réseau ; elle n'est marquée propre qu'après confirmation cloud.
 *  - Les envois cloud d'un même projet sont sérialisés (file par projet) :
 *    une requête ancienne ne peut pas arriver après une plus récente.
 *  - Avant d'écraser le cloud, on vérifie que son `$updatedAt` est celui
 *    connu par cette session (sinon `conflict`, rien n'est écrasé).
 *  - Un document identique au dernier confirmé n'est pas renvoyé.
 *  - Toute erreur cloud remonte (ProjectCloudError), jamais avalée.
 *  - Une charge utile trop grosse pour le document part dans le bucket
 *    `project-payloads` (payloadFiles.ts) ; le document garde un pointeur.
 */
import { createDefaultProject } from '@/features/itineraryPanel/lib/project';
import { applyProjectView, extractProjectView } from '@/features/itineraryPanel/lib/project/layers';
import {
  databases,
  APPWRITE_DATABASE_ID,
  ID,
  Permission,
  PROJECTS_COLLECTION_ID,
  Query,
  Role,
} from '@/shared/services/appwrite';
import { translateAppText } from '@/shared/i18n/config';
import { logger } from '@/shared/lib/logger';
import {
  idbDeleteProject,
  idbGetProject,
  idbGetProjectMeta,
  idbListProjectMetas,
  idbSaveProject,
  idbUpdateProjectMeta,
} from '@/shared/services/storage/idbProjectStore';

import { getCurrentUserId, isLocalFallbackUser, isOwnedBy, toCloudFailure } from './auth';
import { listAllCloudDocuments } from './cloudList';
import {
  buildCloudPayload,
  docToProjectRow,
  withProjectMetaFields,
  settlePayloadFiles,
  updateProjectDocument,
  withNameSync,
  writeCloudData,
  type CloudProjectDoc,
} from './cloudDocuments';
import { ProjectCloudError, toProjectCloudError } from './errors';
import { collectProjectFitUploads, deleteFitUploads } from './fitFiles';
import { readLocalProjects, removeLocalProjectCacheEntry, writeLocalProjects } from './legacyLocalProjects';
import { utf8ByteLength } from './limits';
import { markLocalSynced, writeLocalCopy } from './localCopy';
import {
  deletePayloadFile,
  deleteProjectPayloadFiles,
  downloadProjectPayloadFile,
  isPayloadFilePointer,
  payloadFileExists,
  uploadProjectPayloadFile,
} from './payloadFiles';
import {
  cloudQueues,
  confirmedDocuments,
  enqueue,
  filePayloadProjects,
  isNewer,
  knownCloudVersions,
  localQueues,
  localRevisions,
  payloadFilesChecked,
  rememberCloudVersion,
  withTimeout,
} from './projectSession';
import { deleteProjectView, queueProjectViewSave, readProjectView, saveProjectViewNow } from './projectViews';
import { legacyViewOf, serializeProjectForStorage } from './storedProject';
import { rowToSummary } from './mappers';
import { inaccessibleProjectError, isAccessibleDocument, isOwnDocument, loadAccessQueries } from './access';
import { isServerOwnedDocument, isSharedProject, markSharedProject } from './liveSessions';
import { deleteSharedProjectOnServer } from './sharing';
import type { ItineraryProject, ProjectRow, ProjectRowMeta, ProjectSummary } from './types';

export { isLocalCopyFailing, saveProjectLocally } from './localCopy';

/** Au-delà, une lecture cloud est considérée hors-ligne (copie locale servie). */
const CLOUD_READ_TIMEOUT_MS = 15_000;

// ── Lecture ────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev) {
    try {
      // Query.select : ne jamais télécharger `data` pour afficher la liste ;
      // pagination par curseur jusqu'à épuisement (plus de plafond à 100).
      const documents = await withProjectMetaFields((fields) => listAllCloudDocuments<CloudProjectDoc>(PROJECTS_COLLECTION_ID, [
        Query.equal('user_id', userId),
        Query.orderDesc('$updatedAt'),
        Query.select(fields),
      ]));
      // Ligne d'un autre compte lisible par tous, `user_id` = moi : ignorée (access.ts).
      return documents.filter((doc) => isOwnDocument(doc, userId)).map((doc) => cloudDocToSummary(doc, false));
    } catch (e) {
      const error = toCloudFailure('listProjects', e);
      // Hors-ligne : copies locales de l'utilisateur. Autre erreur : on la remonte.
      if (error.kind !== 'offline') throw error;
    }
  }

  try {
    const idbRows = (await idbListProjectMetas()).filter((row) => isOwnedBy(row, userId));
    if (idbRows.length > 0) {
      return idbRows.map((row) => rowToSummary(row));
    }
  } catch {
    /* repli sur localStorage */
  }

  const local = readLocalProjects().filter((row) => isOwnedBy(row, userId));
  return local.map((row) => rowToSummary(row));
}

function cloudDocToSummary(doc: CloudProjectDoc, sharedWithMe: boolean): ProjectSummary {
  markSharedProject(doc.$id, doc.team_id, doc.user_id);
  return {
    id: doc.$id,
    // Le dossier d'un projet partagé est celui de son propriétaire.
    folderId: sharedWithMe ? null : doc.folder_id ?? null,
    name: doc.name || 'Untitled',
    privacy: doc.privacy || 'private',
    sizeBytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : 0,
    createdAt: doc.$createdAt,
    updatedAt: doc.$updatedAt,
    ...(sharedWithMe || doc.team_id ? { shared: true } : {}),
    ...(sharedWithMe ? { sharedWithMe: true } : {}),
  };
}

/**
 * Projets d'autres propriétaires partagés avec l'utilisateur (Appwrite ne
 * renvoie que les documents qu'il peut lire : ceux de ses équipes). Hors ligne
 * ou compte local : aucun.
 */
export async function listSharedProjects(): Promise<ProjectSummary[]> {
  const userId = await getCurrentUserId();
  if (isLocalFallbackUser(userId)) return [];
  try {
    // Seulement les projets des équipes dont je suis membre (une ligne lisible
    // par tous ne s'invite pas dans « Partagés avec moi » : access.ts).
    const documents = await (await loadAccessQueries()).listSharedWithMe(userId, (teams) => withProjectMetaFields((fields) => listAllCloudDocuments<CloudProjectDoc>(PROJECTS_COLLECTION_ID, [
      Query.equal('team_id', teams),
      Query.notEqual('user_id', userId),
      Query.orderDesc('$updatedAt'),
      Query.select(fields),
    ])));
    return documents.map((doc) => cloudDocToSummary(doc, true));
  } catch (e) {
    const error = toCloudFailure('listSharedProjects', e);
    if (error.kind === 'offline') return [];
    throw error;
  }
}

/** Copies locales de l'utilisateur courant avec des modifications non synchronisées. */
export async function listDirtyProjects(): Promise<ProjectRowMeta[]> {
  const userId = await getCurrentUserId();
  if (isLocalFallbackUser(userId)) return [];
  const metas = await idbListProjectMetas().catch(() => [] as ProjectRowMeta[]);
  return metas.filter((meta) => meta.dirty === true && isOwnedBy(meta, userId) && !meta.id.startsWith('local-'));
}

/**
 * Tente d'envoyer au cloud toutes les copies locales non synchronisées.
 * Renvoie les projets toujours en attente (avec l'erreur rencontrée).
 */
export async function syncDirtyProjects(): Promise<Array<{ meta: ProjectRowMeta; error: unknown }>> {
  const dirty = await listDirtyProjects();
  const failures: Array<{ meta: ProjectRowMeta; error: unknown }> = [];
  for (const meta of dirty) {
    try {
      const row = await idbGetProject(meta.id);
      if (!row?.data) continue;
      await saveProject(meta.id, withNameSync(row).data);
    } catch (error) {
      failures.push({ meta, error });
    }
  }
  return failures;
}

async function fetchCloudRow(id: string): Promise<ProjectRow> {
  const userId = await getCurrentUserId();
  const doc = (await withTimeout(
    databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id),
    CLOUD_READ_TIMEOUT_MS,
  )) as unknown as CloudProjectDoc;
  // Ni à moi ni partagé avec moi (ligne d'un autre lisible par tous) : introuvable.
  if (!(await isAccessibleDocument(doc, userId))) throw inaccessibleProjectError(id);
  const row = await docToProjectRow(doc);
  markSharedProject(id, row.team_id, row.user_id);
  rememberCloudVersion(id, doc.$updatedAt);
  // Copie locale propre (accès hors-ligne), écrite dans la file du projet.
  void enqueue(localQueues, id, () => idbSaveProject(row)).catch((error: unknown) => {
    logger.projects.warn('IndexedDB cache of cloud project failed', error);
  });
  return row;
}

function conflictCopyName(name: string, origin: 'local' | 'remote'): string {
  const suffix = origin === 'local'
    ? translateAppText('copie locale non synchronisée')
    : translateAppText('version d’un autre appareil');
  return `${name || 'Untitled'} (${suffix})`;
}

/** Duplique la version cloud actuelle d'un projet (sans la décompresser) avant de l'écraser. */
async function forkCloudVersion(id: string, userId: string): Promise<string> {
  const doc = (await databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id)) as unknown as CloudProjectDoc;
  const copyId = ID.unique();
  // Fichier de charge utile : la copie a le sien (celui de l'original sera
  // supprimé à sa prochaine sauvegarde).
  let data = doc.data;
  let uploaded: string | null = null;
  if (isPayloadFilePointer(data)) {
    filePayloadProjects.add(id);
    uploaded = await uploadProjectPayloadFile(copyId, userId, await downloadProjectPayloadFile(data));
    data = uploaded;
  }
  try {
    const copy = await databases.createDocument(
      APPWRITE_DATABASE_ID,
      PROJECTS_COLLECTION_ID,
      copyId,
      {
        user_id: userId,
        folder_id: doc.folder_id ?? null,
        name: conflictCopyName(doc.name ?? '', 'remote'),
        data,
        size_bytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : 0,
        privacy: doc.privacy ?? 'private',
      },
      [
        Permission.read(Role.user(userId)),
        Permission.update(Role.user(userId)),
        Permission.delete(Role.user(userId)),
      ],
    );
    return copy.$id;
  } catch (error) {
    if (uploaded) await deletePayloadFile(uploaded);
    throw error;
  }
}

/**
 * Ouvre un projet : son document (cf. `getProjectRow`) composé avec la vue la
 * plus récente de l'utilisateur (projectViews.ts). Un projet au format
 * précédent arrive avec sa vue d'origine ; si l'utilisateur n'en a pas encore
 * de stockée, elle le devient (horodatée à la dernière sauvegarde du projet,
 * elle ne remplace jamais une vraie vue).
 */
export async function getProject(id: string): Promise<ProjectRow | null> {
  const [row, storedView] = await Promise.all([
    getProjectRow(id),
    readProjectView(id).catch(() => null),
  ]);
  if (!row) return null;
  if (storedView) return { ...row, data: applyProjectView(row.data, storedView.view) };
  const legacyView = legacyViewOf(row.data);
  if (legacyView) {
    queueProjectViewSave(id, legacyView, {
      seed: { updatedAt: row.cloud_updated_at ?? row.updated_at },
    });
  }
  return row;
}

/**
 * Document d'un projet en gardant la version la plus récente entre la copie
 * locale et le cloud :
 *  - hors-ligne (ou cloud injoignable) : copie locale ;
 *  - cloud inchangé depuis la base de la copie locale : copie locale (avec ses
 *    éventuelles modifications non synchronisées, `dirty`) ;
 *  - cloud modifié ailleurs et copie locale propre : version cloud ;
 *  - cloud modifié ailleurs ET modifications locales non synchronisées : la plus
 *    récente est ouverte et l'autre est conservée en copie (nouveau projet) ;
 *    si la copie échoue, la version locale est ouverte et la sauvegarde
 *    signalera le conflit au lieu d'écraser le cloud.
 */
async function getProjectRow(id: string): Promise<ProjectRow | null> {
  const userId = await getCurrentUserId();
  const localRow = await idbGetProject(id).catch(() => null);
  const local = localRow?.data && isOwnedBy(localRow, userId) ? withNameSync(localRow) : null;

  if (isLocalFallbackUser(userId) || id.startsWith('local-')) {
    if (local) return local;
    return readLocalProjects().find((p) => p.id === id && isOwnedBy(p, userId)) ?? null;
  }

  if (!local) {
    try {
      return await fetchCloudRow(id);
    } catch (e) {
      const error = toCloudFailure('getProject', e);
      if (error.kind === 'not-found') return null;
      throw error;
    }
  }

  let meta: CloudProjectDoc;
  try {
    meta = (await withProjectMetaFields((fields) => withTimeout(
      databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id, [Query.select(fields)]),
      CLOUD_READ_TIMEOUT_MS,
    ))) as unknown as CloudProjectDoc;
  } catch (e) {
    const error = toCloudFailure('getProject', e);
    if (error.kind === 'not-found') {
      // Supprimé ailleurs : on garde les modifications non synchronisées (la
      // sauvegarde signalera « projet supprimé »), sinon on nettoie la copie.
      if (local.dirty) return local;
      await idbDeleteProject(id).catch(() => undefined);
      return null;
    }
    // Hors-ligne / refus : la copie locale reste utilisable (partagée si son équipe est connue).
    markSharedProject(id, local.team_id);
    return local;
  }

  if (!(await isAccessibleDocument(meta, userId))) {
    // Ligne d'un autre compte (lisible par tous) : jamais ouverte, sa copie locale propre est effacée.
    if (!local.dirty) await idbDeleteProject(id).catch(() => undefined);
    return null;
  }

  // Projet partagé : son document vient du serveur temps réel (jamais de
  // conflit ni de copie) ; ce qui est ouvert ici n'est affiché que le temps
  // de la connexion, puis remplacé par l'état de la session. La copie locale
  // (état de la session vu ici en dernier) sert si elle est plus récente que
  // le dernier point de sauvegarde du serveur ; jamais renvoyée au cloud.
  if (meta.team_id || local.team_id) {
    markSharedProject(id, meta.team_id || local.team_id, meta.user_id);
    const localAt = Date.parse(local.updated_at);
    const cloudAt = Date.parse(meta.$updatedAt);
    if (Number.isFinite(localAt) && Number.isFinite(cloudAt) && localAt > cloudAt) {
      return { ...local, dirty: false, team_id: meta.team_id || local.team_id };
    }
    try {
      return await fetchCloudRow(id);
    } catch (e) {
      toCloudFailure('getProject', e);
      return { ...local, dirty: false, team_id: meta.team_id || local.team_id };
    }
  }

  const cloudUpdatedAt = meta.$updatedAt;
  const base = local.cloud_updated_at ?? null;
  const cloudChanged = base ? isNewer(cloudUpdatedAt, base) : isNewer(cloudUpdatedAt, local.updated_at);

  if (!cloudChanged) {
    // Ligne héritée (sans version de base) plus récente que le cloud : une
    // sauvegarde cloud a probablement échoué → à resynchroniser.
    const dirty = local.dirty === true || (!base && isNewer(local.updated_at, cloudUpdatedAt));
    const nextBase = base ?? cloudUpdatedAt;
    rememberCloudVersion(id, nextBase);
    const row: ProjectRow = withNameSync({
      ...local,
      name: local.dirty ? local.name : meta.name || local.name,
      folder_id: meta.folder_id ?? null,
      dirty,
      cloud_updated_at: nextBase,
      team_id: meta.team_id || null,
    });
    void enqueue(localQueues, id, () =>
      idbUpdateProjectMeta(id, { name: row.name, folder_id: row.folder_id, dirty, cloud_updated_at: nextBase }),
    ).catch(() => undefined);
    return row;
  }

  if (!local.dirty) {
    try {
      return await fetchCloudRow(id);
    } catch (e) {
      toCloudFailure('getProject', e);
      return local;
    }
  }

  // Conflit : modifications locales non synchronisées ET cloud modifié ailleurs.
  logger.projects.warn('Project conflict on open', { id, localUpdatedAt: local.updated_at, cloudUpdatedAt, base });
  if (isNewer(local.updated_at, cloudUpdatedAt)) {
    try {
      const copyId = await forkCloudVersion(id, userId);
      logger.projects.warn('Cloud version preserved as a copy before keeping local changes', { id, copyId });
      rememberCloudVersion(id, cloudUpdatedAt);
      void enqueue(localQueues, id, () => idbUpdateProjectMeta(id, { cloud_updated_at: cloudUpdatedAt })).catch(() => undefined);
      return { ...local, cloud_updated_at: cloudUpdatedAt };
    } catch (e) {
      toCloudFailure('forkCloudVersion', e);
      if (base) rememberCloudVersion(id, base);
      return local;
    }
  }

  try {
    const copy = await createProject(conflictCopyName(local.name, 'local'), local.data, local.folder_id);
    logger.projects.warn('Local unsynced changes preserved as a copy before loading cloud version', { id, copyId: copy.id });
    return await fetchCloudRow(id);
  } catch (e) {
    toCloudFailure('preserveLocalCopy', e);
    if (base) rememberCloudVersion(id, base);
    return local;
  }
}

// ── Écriture ───────────────────────────────────────────────────────────────

export async function createProject(
  name?: string,
  initialData?: ItineraryProject,
  folderId?: string | null,
): Promise<ProjectRow> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);
  const baseProject: ItineraryProject = initialData ?? createDefaultProject();
  const finalProject: ItineraryProject = name ? { ...baseProject, name } : baseProject;

  if (!isDev) {
    let uploaded: string | null = null;
    try {
      const serialized = serializeProjectForStorage(finalProject);
      const cloud = await buildCloudPayload(serialized.documentJson);
      const projectId = ID.unique();
      const written = await writeCloudData(projectId, userId, cloud);
      uploaded = written.uploaded;
      const doc = (await databases.createDocument(
        APPWRITE_DATABASE_ID,
        PROJECTS_COLLECTION_ID,
        projectId,
        {
          user_id: userId,
          folder_id: folderId ?? null,
          name: finalProject.name,
          data: written.data,
          size_bytes: cloud.sizeBytes,
          privacy: finalProject.privacy ?? 'private',
        },
        [
          Permission.read(Role.user(userId)),
          Permission.update(Role.user(userId)),
          Permission.delete(Role.user(userId)),
        ],
      )) as unknown as CloudProjectDoc;
      uploaded = null;

      // Pas de décompression du document renvoyé : on connaît déjà son contenu.
      const row: ProjectRow = {
        id: doc.$id,
        user_id: userId,
        folder_id: doc.folder_id ?? folderId ?? null,
        name: finalProject.name,
        data: finalProject,
        size_bytes: cloud.sizeBytes,
        privacy: finalProject.privacy ?? 'private',
        created_at: doc.$createdAt,
        updated_at: doc.$updatedAt,
        dirty: false,
        cloud_updated_at: doc.$updatedAt,
      };
      rememberCloudVersion(row.id, doc.$updatedAt);
      confirmedDocuments.set(row.id, serialized.documentJson);
      void enqueue(localQueues, row.id, () => idbSaveProject(row, serialized)).catch((error: unknown) => {
        logger.projects.warn('IndexedDB createProject cache failed', error);
      });
      // Projet importé / dupliqué / copie de conflit : il garde la vue de sa source.
      if (initialData) {
        void saveProjectViewNow(row.id, extractProjectView(finalProject)).catch((error: unknown) => {
          logger.projects.warn('createProject view not saved', error);
        });
      }
      return row;
    } catch (e) {
      if (uploaded) await deletePayloadFile(uploaded);
      throw toCloudFailure('createProject', e);
    }
  }

  // Mode local de développement uniquement (pas de session Appwrite) : projet `local-*`.
  const now = new Date().toISOString();
  const localRow: ProjectRow = {
    id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    user_id: userId,
    folder_id: folderId ?? null,
    name: finalProject.name,
    data: finalProject,
    size_bytes: utf8ByteLength(JSON.stringify(finalProject)),
    privacy: finalProject.privacy ?? 'private',
    created_at: now,
    updated_at: now,
  };

  void idbSaveProject(localRow);
  if (initialData) void saveProjectViewNow(localRow.id, extractProjectView(finalProject)).catch(() => undefined);
  const projects = readLocalProjects();
  projects.unshift(localRow);
  writeLocalProjects(projects);
  return localRow;
}

export interface SaveProjectOptions {
  /**
   * JSON du document de `project` (`buildProjectDocument`) déjà calculé par
   * l'appelant : une seule sérialisation par sauvegarde.
   */
  documentJson?: string;
  /**
   * Écrase la version cloud même si elle a été modifiée ailleurs depuis la
   * version connue (choix explicite de l'utilisateur après un conflit).
   */
  force?: boolean;
}

/**
 * Sauvegarde le document d'un projet (la vue part par projectViews.ts) :
 * copie locale d'abord (IndexedDB, `dirty`, avec le travail en attente), puis
 * envoi cloud sérialisé par projet — sauf si le cloud a déjà confirmé ce
 * document (seul le travail local a changé). Lève une `ProjectCloudError` si
 * le cloud n'a pas confirmé ; la copie locale reste alors en attente (`dirty`).
 */
export async function saveProject(
  id: string,
  project: ItineraryProject,
  options: SaveProjectOptions = {},
): Promise<void> {
  const userId = await getCurrentUserId();
  // Projet partagé / en session : le serveur temps réel écrit le document,
  // ce client n'écrit que sa copie locale (jamais d'écrasement, jamais de conflit).
  const localOnly = isLocalFallbackUser(userId) || id.startsWith('local-') || isServerOwnedDocument(id);
  const serialized = serializeProjectForStorage(project, options.documentJson);
  const json = serialized.documentJson;
  const sizeBytes = utf8ByteLength(json);

  // 1. Copie locale avant tout appel réseau (survit à une fermeture d'onglet).
  let revision = localRevisions.get(id) ?? 0;
  try {
    revision = await writeLocalCopy(id, project, userId, serialized, sizeBytes, !localOnly);
  } catch (err) {
    logger.projects.warn('IndexedDB saveProject error', err);
  }

  if (localOnly) return;

  // 2. Envoi cloud, un seul à la fois par projet, dans l'ordre des appels.
  await enqueue(cloudQueues, id, async () => {
    // Vérifié dans la file, une fois les envois précédents terminés.
    const knownVersion = knownCloudVersions.get(id);
    if (!options.force && knownVersion && confirmedDocuments.get(id) === json) {
      await markLocalSynced(id, revision, knownVersion);
      return;
    }
    let uploaded: string | null = null;
    try {
      const cloud = await buildCloudPayload(json, sizeBytes);

      // Version cloud sur laquelle repose ce document : l'écriture est refusée
      // par Appwrite si la ligne a changé depuis (B3-2). Forcée : sans condition.
      let base: string | null = null;
      if (!options.force) {
        base = knownCloudVersions.get(id)
          ?? (await idbGetProjectMeta(id).catch(() => null))?.cloud_updated_at
          ?? null;
        // Contrôle anticipé (n'envoie pas un gros fichier pour rien) ; la
        // garantie est l'écriture conditionnelle, plus bas.
        const current = (await databases.getDocument(
          APPWRITE_DATABASE_ID,
          PROJECTS_COLLECTION_ID,
          id,
          [Query.select(['$id', '$updatedAt'])],
        )) as unknown as CloudProjectDoc;
        if (base && isNewer(current.$updatedAt, base)) {
          logger.projects.warn('Save refused: cloud version changed elsewhere', {
            id,
            base,
            cloudUpdatedAt: current.$updatedAt,
          });
          throw new ProjectCloudError('conflict');
        }
      }

      const fields = {
        name: project.name,
        size_bytes: cloud.sizeBytes,
        privacy: project.privacy ?? 'private',
      };
      let written = await writeCloudData(id, userId, cloud);
      uploaded = written.uploaded;
      let doc = await updateProjectDocument(id, { ...fields, data: written.data }, base);
      uploaded = null;
      // Gros projet : fichier supprimé entre son envoi et l'écriture (élagage
      // d'une sauvegarde concurrente, forcée ou d'une version précédente de
      // l'app) — renvoyé, pour que le document ne pointe jamais dans le vide (B3-1).
      if (written.uploaded && (await payloadFileExists(written.data)) === false) {
        logger.projects.warn('Project payload file pruned before its document was written, uploading it again', { id });
        written = await writeCloudData(id, userId, cloud);
        uploaded = written.uploaded;
        doc = await updateProjectDocument(id, { ...fields, data: written.data }, doc.$updatedAt);
        uploaded = null;
      }
      rememberCloudVersion(id, doc.$updatedAt);
      confirmedDocuments.set(id, json);
      await markLocalSynced(id, revision, doc.$updatedAt);
      await settlePayloadFiles(id, written.data, doc.$updatedAt);
    } catch (e) {
      // Fichier envoyé mais document non pointé dessus : il ne sert à rien.
      if (uploaded) await deletePayloadFile(uploaded);
      // La copie IndexedDB est déjà écrite (dirty) : l'appelant garde la sauvegarde en attente.
      throw toCloudFailure('saveProject', e);
    }
  });
}

/**
 * Lit la version cloud courante puis applique `update` ; si la version de base
 * connue était à jour, elle avance avec la nouvelle `$updatedAt` (évite un faux
 * conflit à la prochaine sauvegarde sans masquer un vrai changement distant).
 * L'écriture est conditionnelle à la version lue : une sauvegarde d'un autre
 * onglet arrivée entre la lecture et l'écriture ne doit pas devenir la base
 * de celui-ci sans avoir été vue (B3-2) ; on relit et on recommence.
 */
export async function updateProjectDocumentKeepingBase(
  id: string,
  update: Record<string, unknown>,
  metaPatch: Partial<Pick<ProjectRowMeta, 'name' | 'folder_id'>> = {},
): Promise<CloudProjectDoc> {
  for (let attempt = 1; ; attempt += 1) {
    const before = (await databases.getDocument(
      APPWRITE_DATABASE_ID,
      PROJECTS_COLLECTION_ID,
      id,
      [Query.select(['$id', '$updatedAt'])],
    )) as unknown as CloudProjectDoc;
    try {
      const doc = await updateProjectDocument(id, update, before.$updatedAt);
      advanceBaseIfCurrent(id, before.$updatedAt, doc.$updatedAt, metaPatch);
      return doc;
    } catch (error) {
      if (attempt >= 3 || toProjectCloudError(error).kind !== 'conflict') throw error;
    }
  }
}

/**
 * Après une mise à jour d'attributs faite par ce client (renommage, dossier) :
 * fait avancer la version de base (mémoire + IndexedDB) si elle valait
 * `before`, et applique `metaPatch` à la copie locale.
 */
function advanceBaseIfCurrent(
  id: string,
  before: string,
  after: string,
  metaPatch: Partial<Pick<ProjectRowMeta, 'name' | 'folder_id'>> = {},
): void {
  if (knownCloudVersions.get(id) === before) knownCloudVersions.set(id, after);
  void enqueue(localQueues, id, () =>
    idbUpdateProjectMeta(id, (meta) => ({
      ...metaPatch,
      ...(meta.cloud_updated_at === before ? { cloud_updated_at: after } : {}),
    })),
  ).catch(() => undefined);
}

/**
 * Renomme un projet : met à jour uniquement l'attribut `name` (jamais `data`,
 * dont la copie pourrait être périmée). Le nom du document fait foi à la
 * lecture (`data.name` est aligné au chargement et réécrit à la sauvegarde).
 */
export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name cannot be empty');

  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev && !id.startsWith('local-')) {
    try {
      await enqueue(cloudQueues, id, () => updateProjectDocumentKeepingBase(id, { name: trimmed }));
    } catch (e) {
      throw toCloudFailure('renameProject', e);
    }
    void enqueue(localQueues, id, () => idbUpdateProjectMeta(id, { name: trimmed })).catch(() => undefined);
    return;
  }

  const projects = readLocalProjects();
  const target = projects.find((p) => p.id === id);
  if (target) {
    target.name = trimmed;
    target.data = { ...target.data, name: trimmed };
    target.updated_at = new Date().toISOString();
    writeLocalProjects(projects);
  }
  void enqueue(localQueues, id, () => idbUpdateProjectMeta(id, { name: trimmed })).catch(() => undefined);
}

export async function moveProjectToFolder(
  id: string,
  folderId: string | null,
): Promise<void> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev && !id.startsWith('local-')) {
    try {
      await enqueue(cloudQueues, id, () => updateProjectDocumentKeepingBase(id, { folder_id: folderId }));
    } catch (e) {
      throw toCloudFailure('moveProjectToFolder', e);
    }
    void enqueue(localQueues, id, () => idbUpdateProjectMeta(id, { folder_id: folderId })).catch(() => undefined);
    return;
  }

  const projects = readLocalProjects();
  const target = projects.find((p) => p.id === id);
  if (target) {
    target.folder_id = folderId;
    target.updated_at = new Date().toISOString();
    writeLocalProjects(projects);
  }
  void enqueue(localQueues, id, () => idbUpdateProjectMeta(id, { folder_id: folderId })).catch(() => undefined);
}

/**
 * Fichiers FIT référencés par le projet, lus avant sa suppression : copie
 * locale si elle existe, sinon la ligne du cloud. Au mieux : un échec de
 * lecture ne bloque jamais la suppression (les fichiers restants sont purgés
 * avec le compte, api/_lib/accountDeletion.ts).
 */
async function storedFitUploads(id: string, userId: string) {
  try {
    const local = await idbGetProject(id);
    if (local?.data && isOwnedBy(local, userId)) return collectProjectFitUploads(local.data);
    return collectProjectFitUploads((await fetchCloudRow(id)).data);
  } catch (error) {
    logger.projects.warn('FIT files of deleted project could not be listed', error);
    return [];
  }
}

export async function deleteProject(id: string): Promise<void> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);
  // Traces GPS et fréquence cardiaque (RGPD) : effacées avec le projet. Avec
  // les droits de l'utilisateur, seuls ses propres fichiers partent (dans un
  // projet partagé, ceux des autres éditeurs restent à eux).
  const fitUploads = isDev || id.startsWith('local-') ? [] : await storedFitUploads(id, userId);

  // 1. Suppression cloud d'abord : en cas d'échec la copie locale reste intacte
  //    et l'erreur remonte (pas de faux succès suivi d'une « réapparition »).
  if (!isDev && !id.startsWith('local-')) {
    // Projet partagé : le serveur supprime aussi l'équipe, le journal et les
    // points de sauvegarde de la co-édition (clé admin) ; la ligne avec.
    if (isSharedProject(id)) await deleteSharedProjectOnServer(id);
    try {
      await enqueue(cloudQueues, id, () =>
        databases.deleteDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id),
      );
    } catch (e) {
      const error = toCloudFailure('deleteProject', e);
      // Déjà supprimé côté cloud : on termine le nettoyage local.
      if (error.kind !== 'not-found') throw error;
    }
    // Fichiers de charge utile éventuels (gros projets), sans faire échouer la suppression.
    await enqueue(cloudQueues, id, () => deleteProjectPayloadFiles(id));
    await deleteFitUploads(fitUploads);
    filePayloadProjects.delete(id);
    payloadFilesChecked.delete(id);
  }

  // 2. Suppression locale.
  await forgetProjectOnDevice(id);

  const projects = readLocalProjects().filter((p) => p.id !== id);
  writeLocalProjects(projects);
}

/**
 * Retire un projet de cet appareil : copie IndexedDB (document, travail
 * local, cache, miniature, vue), cache localStorage du Dashboard, état de
 * session, et la vue de l'utilisateur (locale et cloud). Après une
 * suppression, et quand l'utilisateur quitte un projet partagé : la copie de
 * ce projet n'était jamais rouverte, donc jamais nettoyée.
 */
export async function forgetProjectOnDevice(id: string): Promise<void> {
  try {
    await enqueue(localQueues, id, () => idbDeleteProject(id));
  } catch (e) {
    logger.projects.warn('IndexedDB deleteProject failed', e);
  }
  removeLocalProjectCacheEntry(id);
  knownCloudVersions.delete(id);
  confirmedDocuments.delete(id);
  localRevisions.delete(id);
  // Vue de l'utilisateur (locale et cloud), sans faire échouer l'appelant.
  await deleteProjectView(id).catch(() => undefined);
}
