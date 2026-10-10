import { logger } from '@/shared/lib/logger';
import { APPWRITE_DATABASE_ID, client, databases, PROJECTS_COLLECTION_ID, Query } from '@/shared/services/appwrite';
import {
  decompressProjectBytes,
  decompressProjectPayload,
} from './compression';
import { ProjectCloudError } from './errors';
import {
  isCloudPayloadTooLarge,
  isProjectTooLarge,
  MAX_CLOUD_PROJECT_FILE_BYTES,
  utf8ByteLength,
} from './limits';
import { encodeProjectPayloadOffThread } from './payloadEncodingClient';
import {
  downloadProjectPayloadFile,
  isPayloadFilePointer,
  latestPayloadPointerExcept,
  pruneProjectPayloadFiles,
  uploadProjectPayloadFile,
} from './payloadFiles';
import { filePayloadProjects, payloadFilesChecked } from './projectSession';
import { carryLegacyView, parseStoredProject } from './storedProject';
import type { ItineraryProject, ProjectRow } from './types';

// Documents Appwrite des projets : lecture (document → ligne) et charge utile
// à écrire (dans le document, ou fichier du bucket au-delà de la limite).

/**
 * Champs lus pour la liste et le contrôle de fraîcheur (jamais `data`) ;
 * `$permissions` dit si la ligne est vraiment à l'utilisateur ou partagée
 * avec lui (access.ts).
 */
const PROJECT_META_FIELDS = [
  '$id',
  '$permissions',
  'name',
  'folder_id',
  'privacy',
  'size_bytes',
  'user_id',
  '$createdAt',
  '$updatedAt',
];

/**
 * `team_id` (co-édition) n'existe qu'après la migration du schéma
 * (scripts/appwrite/setup-appwrite-schema.mjs) : tant qu'Appwrite le refuse (400), les
 * lectures repartent sans lui, une fois pour toute la session.
 */
let teamFieldAvailable = true;

function isUnknownTeamFieldError(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === 400 && typeof message === 'string' && message.includes('team_id');
}

/** Lecture avec les champs de la liste (+ `team_id` quand le schéma le connaît). */
export async function withProjectMetaFields<T>(read: (fields: string[]) => Promise<T>): Promise<T> {
  if (!teamFieldAvailable) return read(PROJECT_META_FIELDS);
  try {
    return await read([...PROJECT_META_FIELDS, 'team_id']);
  } catch (error) {
    if (!isUnknownTeamFieldError(error)) throw error;
    teamFieldAvailable = false;
    return read(PROJECT_META_FIELDS);
  }
}

export type CloudProjectDoc = {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
  $permissions?: string[];
  user_id?: string;
  team_id?: string | null;
  folder_id?: string | null;
  name?: string;
  data?: unknown;
  size_bytes?: number;
  privacy?: ProjectRow['privacy'];
};

/** Le nom du document (renommage sans réécrire `data`) fait foi sur `data.name`. */
export function withNameSync(row: ProjectRow): ProjectRow {
  if (!row.name || row.data.name === row.name) return row;
  return { ...row, data: carryLegacyView(row.data, { ...row.data, name: row.name }) };
}

/**
 * Lit le fichier pointé par `data` ; une erreur remonte (jamais un projet vide
 * à la place). Fichier disparu (deux sauvegardes concurrentes d'une ancienne
 * version de l'app, B3-1) : le plus récent fichier encore présent du projet
 * est lu à la place.
 */
async function readPayloadFile(projectId: string, pointer: string): Promise<unknown> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await downloadProjectPayloadFile(pointer);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 404) throw error;
    const fallback = await latestPayloadPointerExcept(projectId, pointer).catch(() => null);
    if (!fallback) {
      // Ce n'est pas le projet qui est supprimé. Sans code HTTP, l'erreur est
      // classée « cloud injoignable » et la copie locale sert.
      throw new Error(`Project payload file missing: ${pointer}`, { cause: error });
    }
    logger.projects.warn('Project payload file missing, reading the latest one left', { projectId, pointer, fallback });
    bytes = await downloadProjectPayloadFile(fallback);
  }
  return decodePayload(() => decompressProjectBytes(bytes));
}

/** Décodage de la charge utile : un échec la déclare illisible (jamais « cloud injoignable »). */
async function decodePayload(decode: () => Promise<unknown>): Promise<unknown> {
  try {
    return await decode();
  } catch (error) {
    throw new ProjectCloudError('unreadable', { cause: error });
  }
}

/**
 * Document cloud → ligne projet. `data` est le document partagé (`schema: 2`)
 * ou, pour un projet pas encore réenregistré, le projet composé des versions
 * précédentes : sa vue sert alors de vue par défaut (cf. storedProject.ts).
 * Des données indécodables lèvent `ProjectCloudError('unreadable')` : un
 * projet vide ouvert à leur place serait enregistré par-dessus à la première
 * modification.
 */
export async function docToProjectRow(doc: CloudProjectDoc): Promise<ProjectRow> {
  const { data } = doc;
  let raw: unknown;
  if (isPayloadFilePointer(data)) {
    filePayloadProjects.add(doc.$id);
    raw = await readPayloadFile(doc.$id, data);
  } else if (typeof data === 'string') {
    raw = await decodePayload(() => decompressProjectPayload(data));
  } else {
    raw = data;
  }
  const parsedData: ItineraryProject | undefined = parseStoredProject(raw)?.project;
  if (!parsedData) {
    throw new ProjectCloudError('unreadable', { cause: new Error(`Project ${doc.$id}: data is not a project`) });
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
    team_id: doc.team_id || null,
  });
}

/** Charge utile cloud : dans le document (`data`), ou gzip à envoyer dans le bucket. */
type CloudPayload =
  | { sizeBytes: number; data: string; gzip?: undefined }
  | { sizeBytes: number; data?: undefined; gzip: Uint8Array<ArrayBuffer> };

/**
 * Prépare la charge utile cloud du JSON d'un document de projet (déjà
 * sérialisé par l'appelant) : compression gzip. Jusqu'à 12 M car. (`gz:` +
 * base64, limite du proxy devant Appwrite) elle reste dans le document ;
 * au-delà, le gzip part dans le bucket (`writeCloudData`). Lève une
 * `ProjectCloudError('too-large')` au-delà de la limite du bucket au lieu
 * d'envoyer une requête vouée à l'échec.
 */
export async function buildCloudPayload(json: string, sizeBytes: number = utf8ByteLength(json)): Promise<CloudPayload> {
  if (isProjectTooLarge(sizeBytes)) {
    throw new ProjectCloudError('too-large');
  }
  // Gzip + base64 dans un worker (payloadEncodingClient.ts) : ~1 s de fil principal sur un gros projet.
  const encoded = await encodeProjectPayloadOffThread(json);
  if (!encoded.compressed) {
    // Pas de CompressionStream : JSON brut dans le document s'il tient.
    if (isCloudPayloadTooLarge(json)) throw new ProjectCloudError('too-large');
    return { sizeBytes, data: json };
  }
  if (encoded.data !== null) {
    return { sizeBytes, data: encoded.data };
  }
  const gzip = encoded.gzip!;
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
export async function writeCloudData(
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
 * Écrit des attributs du document d'un projet. `unchangedSince` (version
 * `$updatedAt` sur laquelle repose l'écriture) la rend conditionnelle :
 * Appwrite relit la ligne sous verrou et refuse (409
 * `document_update_conflict`) si elle a été modifiée après — en-tête
 * `X-Appwrite-Timestamp`, que les méthodes du SDK web ne savent pas poser.
 * Un contrôle de version fait avant l'écriture laissait deux sauvegardes
 * concurrentes (onglets, appareils) s'écraser sans conflit (B3-2).
 */
export async function updateProjectDocument(
  projectId: string,
  update: Record<string, unknown>,
  unchangedSince: string | null,
): Promise<CloudProjectDoc> {
  const url = new URL(
    `${client.config.endpoint}/databases/${encodeURIComponent(APPWRITE_DATABASE_ID)}/collections/${encodeURIComponent(PROJECTS_COLLECTION_ID)}/documents/${encodeURIComponent(projectId)}`,
  );
  // X-Appwrite-Project explicite : le SDK web ne l'ajoute pas à client.call (accessQueries.ts).
  const headers: Record<string, string> = {
    'X-Appwrite-Project': client.config.project,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (unchangedSince) headers['X-Appwrite-Timestamp'] = unchangedSince;
  return (await client.call('patch', url, headers, { data: update })) as CloudProjectDoc;
}

/**
 * Après une écriture confirmée du document (`writtenAt` = son `$updatedAt`) :
 * supprime les fichiers de charge utile du projet créés avant elle (pas ceux
 * d'une sauvegarde plus récente d'un autre onglet, pruneProjectPayloadFiles).
 * Un projet jamais vu en fichier dans cette session est quand même vérifié
 * une fois (fichier laissé par un autre appareil avant que le projet ne
 * repasse sous la limite).
 */
export async function settlePayloadFiles(projectId: string, data: string, writtenAt: string): Promise<void> {
  if (!filePayloadProjects.has(projectId) && payloadFilesChecked.has(projectId)) return;
  // Ligne réécrite depuis notre écriture (onglet d'une version précédente,
  // sans écriture conditionnelle ; sauvegarde forcée) : son fichier peut être
  // antérieur au nôtre et le seul pointé. Relu juste avant de supprimer ;
  // réécrite, rien n'est élagué — la sauvegarde suivante le fera.
  const stillOurs = async () => {
    const current = (await databases.getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, projectId, [
      Query.select(['$id', '$updatedAt']),
    ])) as unknown as CloudProjectDoc;
    if (current.$updatedAt === writtenAt) return true;
    logger.projects.warn('Payload files prune skipped: project row rewritten since this save', { projectId });
    return false;
  };
  if (!(await pruneProjectPayloadFiles(projectId, data, writtenAt, stillOurs))) return;
  payloadFilesChecked.add(projectId);
  if (!isPayloadFilePointer(data)) filePayloadProjects.delete(projectId);
}
