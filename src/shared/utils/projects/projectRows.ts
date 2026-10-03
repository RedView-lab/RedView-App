/**
 * Persistance des projets : copie locale IndexedDB + document Appwrite.
 *
 * Invariants :
 *  - Toute sauvegarde écrit d'abord la copie locale (marquée `dirty`) avant
 *    tout appel réseau ; elle n'est marquée propre qu'après confirmation cloud.
 *  - Les envois cloud d'un même projet sont sérialisés (file par projet) :
 *    une requête ancienne ne peut pas arriver après une plus récente.
 *  - Avant d'écraser le cloud, on vérifie que son `$updatedAt` est celui
 *    connu par cette session (sinon `conflict`, rien n'est écrasé).
 *  - Toute erreur cloud remonte (ProjectCloudError), jamais avalée.
 *  - Une charge utile trop grosse pour le document part dans le bucket
 *    `project-payloads` (payloadFiles.ts) ; le document garde un pointeur.
 */
import { createDefaultProject } from '@/features/itineraryPanel/lib/project';
import { PROJECT_CACHE_KEY_PREFIX } from '@/features/map3d/lib/mapCacheEpoch';
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
} from '@/shared/utils/storage/idbProjectStore';

import { getCurrentUserId, isLocalFallbackUser, isOwnedBy, toCloudFailure } from './auth';
import { listAllCloudDocuments } from './cloudList';
import {
  decompressProjectBytes,
  decompressProjectPayload,
  encodeGzipPayload,
  gzipProjectJson,
} from './compression';
import { ProjectCloudError } from './errors';
import {
  gzipPayloadChars,
  isCloudPayloadTooLarge,
  isProjectTooLarge,
  MAX_CLOUD_PROJECT_FILE_BYTES,
  MAX_CLOUD_PROJECT_PAYLOAD_CHARS,
  utf8ByteLength,
} from './limits';
import {
  deletePayloadFile,
  downloadProjectPayloadFile,
  isPayloadFilePointer,
  pruneProjectPayloadFiles,
  uploadProjectPayloadFile,
} from './payloadFiles';
import { rowToSummary } from './mappers';
import type { ItineraryProject, ProjectRow, ProjectRowMeta, ProjectSummary } from './types';

const LOCAL_PROJECTS_KEY = 'redview:local-projects:v1';

/** Champs lus pour la liste et le contrôle de fraîcheur (jamais `data`). */
const PROJECT_META_FIELDS = [
  '$id',
  'name',
  'folder_id',
  'privacy',
  'size_bytes',
  'user_id',
  '$createdAt',
  '$updatedAt',
];

/** Au-delà, une lecture cloud est considérée hors-ligne (copie locale servie). */
const CLOUD_READ_TIMEOUT_MS = 15_000;

type CloudProjectDoc = {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
  user_id?: string;
  folder_id?: string | null;
  name?: string;
  data?: unknown;
  size_bytes?: number;
  privacy?: ProjectRow['privacy'];
};

// ── État de session ─────────────────────────────────────────────────────────

/** `$updatedAt` cloud connu par cette session (version chargée ou dernière sauvegarde). */
const knownCloudVersions = new Map<string, string>();
/** Révision locale par projet : seule la dernière écriture locale peut être marquée propre. */
const localRevisions = new Map<string, number>();
const localQueues = new Map<string, Promise<unknown>>();
const cloudQueues = new Map<string, Promise<unknown>>();
/** Projets dont la charge utile cloud est (ou était) un fichier du bucket. */
const filePayloadProjects = new Set<string>();
/** Projets dont les fichiers de charge utile ont déjà été vérifiés dans cette session. */
const payloadFilesChecked = new Set<string>();

function enqueue<T>(queues: Map<string, Promise<unknown>>, id: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

function rememberCloudVersion(id: string, updatedAt: string | null | undefined): void {
  if (updatedAt) knownCloudVersions.set(id, updatedAt);
}

function isNewer(candidate: string | null | undefined, reference: string | null | undefined): boolean {
  if (!candidate) return false;
  if (!reference) return true;
  const a = Date.parse(candidate);
  const b = Date.parse(reference);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return candidate !== reference;
  return a > b;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Cloud request timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── Stockage local hérité (mode dev sans Appwrite) ─────────────────────────

function readLocalProjects(): ProjectRow[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_PROJECTS_KEY);
    return raw ? (JSON.parse(raw) as ProjectRow[]) : [];
  } catch {
    return [];
  }
}

function writeLocalProjects(projects: ProjectRow[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
  } catch (e) {
    // QuotaExceededError ignoré sans risque : IndexedDB a déjà persisté la donnée complète
    logger.projects.debug('LocalStorage write skipped or quota exceeded', e);
  }
}

function removeLocalProjectCacheEntry(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(`${PROJECT_CACHE_KEY_PREFIX}${id}`);
  } catch {
    // ignore storage access errors
  }
}

// ── Conversions ────────────────────────────────────────────────────────────

/** Le nom du document (renommage sans réécrire `data`) fait foi sur `data.name`. */
function withNameSync(row: ProjectRow): ProjectRow {
  if (!row.name || row.data.name === row.name) return row;
  return { ...row, data: { ...row.data, name: row.name } };
}

/** Lit le fichier pointé par `data` ; une erreur remonte (jamais un projet vide à la place). */
async function readPayloadFile(pointer: string): Promise<ItineraryProject> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await downloadProjectPayloadFile(pointer);
  } catch (error) {
    // Fichier introuvable : ce n'est pas le projet qui est supprimé. Sans code
    // HTTP, l'erreur est classée « cloud injoignable » et la copie locale sert.
    const code = (error as { code?: unknown } | null)?.code;
    throw code === 404 ? new Error(`Project payload file missing: ${pointer}`, { cause: error }) : error;
  }
  return decompressProjectBytes(bytes);
}

async function docToProjectRow(doc: CloudProjectDoc): Promise<ProjectRow> {
  let parsedData: ItineraryProject;
  if (isPayloadFilePointer(doc.data)) {
    filePayloadProjects.add(doc.$id);
    parsedData = await readPayloadFile(doc.data);
  } else if (typeof doc.data === 'string') {
    try {
      parsedData = await decompressProjectPayload(doc.data);
    } catch (error) {
      logger.projects.error('Project payload could not be decoded', doc.$id, error);
      parsedData = createDefaultProject();
    }
  } else if (doc.data && typeof doc.data === 'object') {
    parsedData = doc.data as ItineraryProject;
  } else {
    parsedData = createDefaultProject();
  }

  return withNameSync({
    id: doc.$id,
    user_id: doc.user_id ?? '',
    folder_id: doc.folder_id ?? null,
    name: doc.name || parsedData.name || 'Untitled',
    data: parsedData,
    size_bytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : 0,
    privacy: doc.privacy || 'private',
    created_at: doc.$createdAt,
    updated_at: doc.$updatedAt,
    dirty: false,
    cloud_updated_at: doc.$updatedAt,
  });
}

/** Charge utile cloud : dans le document (`data`), ou gzip à envoyer dans le bucket. */
type CloudPayload =
  | { sizeBytes: number; data: string; gzip?: undefined }
  | { sizeBytes: number; data?: undefined; gzip: Uint8Array<ArrayBuffer> };

/**
 * Prépare la charge utile cloud d'un projet : sérialise une seule fois (ou
 * réutilise `serialized`) et compresse. Jusqu'à 12 M car. (`gz:` + base64,
 * limite du proxy devant Appwrite) elle reste dans le document ; au-delà, le
 * gzip part dans le bucket (`writeCloudData`). Lève une
 * `ProjectCloudError('too-large')` au-delà de la limite du bucket au lieu
 * d'envoyer une requête vouée à l'échec.
 */
async function buildCloudPayload(project: ItineraryProject, serialized?: string): Promise<CloudPayload> {
  const json = serialized ?? JSON.stringify(project);
  const sizeBytes = utf8ByteLength(json);
  if (isProjectTooLarge(sizeBytes)) {
    throw new ProjectCloudError('too-large');
  }
  const gzip = await gzipProjectJson(json);
  if (!gzip) {
    // Pas de CompressionStream : JSON brut dans le document s'il tient.
    if (isCloudPayloadTooLarge(json)) throw new ProjectCloudError('too-large');
    return { sizeBytes, data: json };
  }
  if (gzipPayloadChars(gzip.byteLength) <= MAX_CLOUD_PROJECT_PAYLOAD_CHARS) {
    return { sizeBytes, data: encodeGzipPayload(gzip) };
  }
  if (gzip.byteLength > MAX_CLOUD_PROJECT_FILE_BYTES) {
    logger.projects.warn('Cloud payload exceeds file limit', {
      sizeBytes,
      gzipBytes: gzip.byteLength,
      maxBytes: MAX_CLOUD_PROJECT_FILE_BYTES,
    });
    throw new ProjectCloudError('too-large');
  }
  return { sizeBytes, gzip };
}

/**
 * Valeur à écrire dans `data` : la charge utile du document, ou le pointeur
 * du fichier tout juste envoyé (`uploaded`, à supprimer si l'écriture du
 * document échoue ensuite).
 */
async function writeCloudData(
  projectId: string,
  userId: string,
  payload: CloudPayload,
): Promise<{ data: string; uploaded: string | null }> {
  if (payload.data !== undefined) return { data: payload.data, uploaded: null };
  try {
    const pointer = await uploadProjectPayloadFile(projectId, userId, payload.gzip);
    filePayloadProjects.add(projectId);
    return { data: pointer, uploaded: pointer };
  } catch (error) {
    // Bucket absent (404) ou fichier refusé (400 : taille / extension) : le
    // projet ne peut pas aller dans le cloud, mais ce n'est pas lui qui a
    // disparu. Réseau / session : classés normalement par l'appelant.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 404 || code === 400) {
      logger.projects.error('Project payload upload refused', { projectId, code, error });
      throw new ProjectCloudError('too-large', { status: code, cause: error });
    }
    throw error;
  }
}

/**
 * Après une écriture confirmée du document : supprime les anciens fichiers de
 * charge utile du projet. Appelée dans la file cloud du projet, donc aucune
 * sauvegarde suivante n'a pu envoyer un fichier entre-temps. Un projet jamais
 * vu en fichier dans cette session est quand même vérifié une fois (fichier
 * laissé par un autre appareil avant que le projet ne repasse sous la limite).
 */
async function settlePayloadFiles(projectId: string, data: string): Promise<void> {
  if (!filePayloadProjects.has(projectId) && payloadFilesChecked.has(projectId)) return;
  payloadFilesChecked.add(projectId);
  await pruneProjectPayloadFiles(projectId, data);
  if (!isPayloadFilePointer(data)) filePayloadProjects.delete(projectId);
}

// ── Copie locale ───────────────────────────────────────────────────────────

/**
 * Écrit la copie locale d'un projet (IndexedDB), sans réseau. Conserve dossier,
 * date de création et version cloud de base de la ligne existante. Renvoie la
 * révision locale écrite.
 */
function writeLocalCopy(
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
function markLocalSynced(id: string, revision: number, cloudUpdatedAt: string): Promise<void> {
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

// ── Lecture ────────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  if (!isDev) {
    try {
      // Query.select : ne jamais télécharger `data` pour afficher la liste ;
      // pagination par curseur jusqu'à épuisement (plus de plafond à 100).
      const documents = await listAllCloudDocuments<CloudProjectDoc>(PROJECTS_COLLECTION_ID, [
        Query.equal('user_id', userId),
        Query.orderDesc('$updatedAt'),
        Query.select(PROJECT_META_FIELDS),
      ]);
      return documents.map((doc) => ({
        id: doc.$id,
        folderId: doc.folder_id ?? null,
        name: doc.name || 'Untitled',
        privacy: doc.privacy || 'private',
        sizeBytes: typeof doc.size_bytes === 'number' ? doc.size_bytes : 0,
        createdAt: doc.$createdAt,
        updatedAt: doc.$updatedAt,
      }));
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
    /* fallback to localStorage */
  }

  const local = readLocalProjects().filter((row) => isOwnedBy(row, userId));
  return local.map((row) => rowToSummary(row));
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
  const doc = (await withTimeout(
    databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id),
    CLOUD_READ_TIMEOUT_MS,
  )) as unknown as CloudProjectDoc;
  const row = await docToProjectRow(doc);
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
 * Ouvre un projet en gardant la version la plus récente entre la copie locale
 * et le cloud :
 *  - hors-ligne (ou cloud injoignable) : copie locale ;
 *  - cloud inchangé depuis la base de la copie locale : copie locale (avec ses
 *    éventuelles modifications non synchronisées, `dirty`) ;
 *  - cloud modifié ailleurs et copie locale propre : version cloud ;
 *  - cloud modifié ailleurs ET modifications locales non synchronisées : la plus
 *    récente est ouverte et l'autre est conservée en copie (nouveau projet) ;
 *    si la copie échoue, la version locale est ouverte et la sauvegarde
 *    signalera le conflit au lieu d'écraser le cloud.
 */
export async function getProject(id: string): Promise<ProjectRow | null> {
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
    meta = (await withTimeout(
      databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id, [Query.select(PROJECT_META_FIELDS)]),
      CLOUD_READ_TIMEOUT_MS,
    )) as unknown as CloudProjectDoc;
  } catch (e) {
    const error = toCloudFailure('getProject', e);
    if (error.kind === 'not-found') {
      // Supprimé ailleurs : on garde les modifications non synchronisées (la
      // sauvegarde signalera « projet supprimé »), sinon on nettoie la copie.
      if (local.dirty) return local;
      await idbDeleteProject(id).catch(() => undefined);
      return null;
    }
    // Hors-ligne / refus : la copie locale reste utilisable.
    return local;
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
      const json = JSON.stringify(finalProject);
      const cloud = await buildCloudPayload(finalProject, json);
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
      void enqueue(localQueues, row.id, () => idbSaveProject(row, json)).catch((error: unknown) => {
        logger.projects.warn('IndexedDB createProject cache failed', error);
      });
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
  const projects = readLocalProjects();
  projects.unshift(localRow);
  writeLocalProjects(projects);
  return localRow;
}

export interface SaveProjectOptions {
  /** JSON de `project` déjà calculé par l'appelant (une seule sérialisation par sauvegarde). */
  serialized?: string;
  /**
   * Écrase la version cloud même si elle a été modifiée ailleurs depuis la
   * version connue (choix explicite de l'utilisateur après un conflit).
   */
  force?: boolean;
}

/**
 * Sauvegarde un projet : copie locale d'abord (IndexedDB, `dirty`), puis envoi
 * cloud sérialisé par projet. Lève une `ProjectCloudError` si le cloud n'a pas
 * confirmé ; la copie locale reste alors en attente (`dirty`).
 */
export async function saveProject(
  id: string,
  project: ItineraryProject,
  options: SaveProjectOptions = {},
): Promise<void> {
  const userId = await getCurrentUserId();
  const localOnly = isLocalFallbackUser(userId) || id.startsWith('local-');
  const json = options.serialized ?? JSON.stringify(project);
  const sizeBytes = utf8ByteLength(json);

  // 1. Copie locale avant tout appel réseau (survit à une fermeture d'onglet).
  let revision = localRevisions.get(id) ?? 0;
  try {
    revision = await writeLocalCopy(id, project, userId, json, sizeBytes, !localOnly);
  } catch (err) {
    logger.projects.warn('IndexedDB saveProject error', err);
  }

  if (localOnly) return;

  // 2. Envoi cloud, un seul à la fois par projet, dans l'ordre des appels.
  await enqueue(cloudQueues, id, async () => {
    let uploaded: string | null = null;
    try {
      const cloud = await buildCloudPayload(project, json);

      if (!options.force) {
        const base = knownCloudVersions.get(id)
          ?? (await idbGetProjectMeta(id).catch(() => null))?.cloud_updated_at
          ?? null;
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

      const written = await writeCloudData(id, userId, cloud);
      uploaded = written.uploaded;
      const doc = (await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, id, {
        name: project.name,
        data: written.data,
        size_bytes: cloud.sizeBytes,
        privacy: project.privacy ?? 'private',
      })) as unknown as CloudProjectDoc;
      uploaded = null;
      rememberCloudVersion(id, doc.$updatedAt);
      await markLocalSynced(id, revision, doc.$updatedAt);
      await settlePayloadFiles(id, written.data);
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
 */
async function updateProjectDocumentKeepingBase(
  id: string,
  update: Record<string, unknown>,
): Promise<CloudProjectDoc> {
  const before = (await databases.getDocument(
    APPWRITE_DATABASE_ID,
    PROJECTS_COLLECTION_ID,
    id,
    [Query.select(['$id', '$updatedAt'])],
  )) as unknown as CloudProjectDoc;
  const doc = (await databases.updateDocument(
    APPWRITE_DATABASE_ID,
    PROJECTS_COLLECTION_ID,
    id,
    update,
  )) as unknown as CloudProjectDoc;
  advanceBaseIfCurrent(id, before.$updatedAt, doc.$updatedAt);
  return doc;
}

/**
 * Après une mise à jour d'attributs faite par ce client (renommage, dossier) :
 * fait avancer la version de base (mémoire + IndexedDB) si elle valait
 * `before`, et applique `metaPatch` à la copie locale.
 */
export function advanceBaseIfCurrent(
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

export async function deleteProject(id: string): Promise<void> {
  const userId = await getCurrentUserId();
  const isDev = isLocalFallbackUser(userId);

  // 1. Suppression cloud d'abord : en cas d'échec la copie locale reste intacte
  //    et l'erreur remonte (pas de faux succès suivi d'une « réapparition »).
  if (!isDev && !id.startsWith('local-')) {
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
    await enqueue(cloudQueues, id, () => pruneProjectPayloadFiles(id, null));
    filePayloadProjects.delete(id);
    payloadFilesChecked.delete(id);
  }

  // 2. Suppression locale : IndexedDB (projet + cache + miniature), cache
  //    localStorage du Dashboard et état de session.
  try {
    await enqueue(localQueues, id, () => idbDeleteProject(id));
  } catch (e) {
    logger.projects.warn('IndexedDB deleteProject failed', e);
  }
  removeLocalProjectCacheEntry(id);
  knownCloudVersions.delete(id);
  localRevisions.delete(id);

  const projects = readLocalProjects().filter((p) => p.id !== id);
  writeLocalProjects(projects);
}
