import { logger } from '@/shared/lib/logger';
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

/** Lit le fichier pointé par `data` ; une erreur remonte (jamais un projet vide à la place). */
async function readPayloadFile(pointer: string): Promise<unknown> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await downloadProjectPayloadFile(pointer);
  } catch (error) {
    // Fichier introuvable : ce n'est pas le projet qui est supprimé. Sans code
    // HTTP, l'erreur est classée « cloud injoignable » et la copie locale sert.
    const code = (error as { code?: unknown } | null)?.code;
    throw code === 404 ? new Error(`Project payload file missing: ${pointer}`, { cause: error }) : error;
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
    raw = await readPayloadFile(data);
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
 * Après une écriture confirmée du document : supprime les anciens fichiers de
 * charge utile du projet. Appelée dans la file cloud du projet, donc aucune
 * sauvegarde suivante n'a pu envoyer un fichier entre-temps. Un projet jamais
 * vu en fichier dans cette session est quand même vérifié une fois (fichier
 * laissé par un autre appareil avant que le projet ne repasse sous la limite).
 */
export async function settlePayloadFiles(projectId: string, data: string): Promise<void> {
  if (!filePayloadProjects.has(projectId) && payloadFilesChecked.has(projectId)) return;
  payloadFilesChecked.add(projectId);
  await pruneProjectPayloadFiles(projectId, data);
  if (!isPayloadFilePointer(data)) filePayloadProjects.delete(projectId);
}
