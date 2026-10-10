/**
 * Charges utiles des gros projets dans le bucket Appwrite `project-payloads`.
 *
 * Au-delà de MAX_CLOUD_PROJECT_PAYLOAD_CHARS, le JSON gzip d'un projet ne tient
 * plus dans l'attribut `projects.data` (limite du nginx devant Appwrite) : il
 * est envoyé comme fichier (upload découpé en morceaux de 5 Mo par le SDK) et
 * le document ne garde qu'un pointeur `file:<fileId>`.
 *
 * Remplacement sans fenêtre de perte : chaque sauvegarde crée un NOUVEAU
 * fichier, le document est ensuite pointé dessus, et seulement alors les
 * anciens fichiers du projet (même nom `<projectId>.json.gz`) sont supprimés.
 * Un échec à n'importe quelle étape laisse le document sur une version lisible.
 */
import {
  client,
  ID,
  Permission,
  PROJECT_PAYLOADS_BUCKET_ID,
  Query,
  Role,
  storage,
} from '@/shared/services/appwrite';
import { logger } from '@/shared/lib/logger';

const FILE_POINTER_PREFIX = 'file:';
/** Au-delà, un téléchargement est considéré hors-ligne (copie locale servie). */
const PAYLOAD_DOWNLOAD_TIMEOUT_MS = 120_000;

export function isPayloadFilePointer(data: unknown): data is string {
  return typeof data === 'string' && data.startsWith(FILE_POINTER_PREFIX);
}

function toPayloadFilePointer(fileId: string): string {
  return `${FILE_POINTER_PREFIX}${fileId}`;
}

function payloadFileIdOf(pointer: string): string {
  return pointer.slice(FILE_POINTER_PREFIX.length);
}

function payloadFileName(projectId: string): string {
  return `${projectId}.json.gz`;
}

/** Envoie le gzip d'un projet dans un nouveau fichier ; renvoie le pointeur à écrire dans `data`. */
export async function uploadProjectPayloadFile(
  projectId: string,
  userId: string,
  gzip: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const fileId = ID.unique();
  const file = new File([gzip], payloadFileName(projectId), { type: 'application/gzip' });
  await storage.createFile(PROJECT_PAYLOADS_BUCKET_ID, fileId, file, [
    Permission.read(Role.user(userId)),
    Permission.update(Role.user(userId)),
    Permission.delete(Role.user(userId)),
  ]);
  return toPayloadFilePointer(fileId);
}

/**
 * Télécharge le gzip pointé par `data` via le client Appwrite (session cookie
 * + `X-Fallback-Cookies`). Toute erreur remonte : un projet illisible ne doit
 * jamais être remplacé par un projet vide.
 */
export async function downloadProjectPayloadFile(pointer: string): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(storage.getFileDownload(PROJECT_PAYLOADS_BUCKET_ID, payloadFileIdOf(pointer)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data: unknown = await Promise.race([
      client.call('get', url, {}, {}, 'arrayBuffer'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Project payload download timed out after ${PAYLOAD_DOWNLOAD_TIMEOUT_MS} ms`)),
          PAYLOAD_DOWNLOAD_TIMEOUT_MS,
        );
      }),
    ]);
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
      throw new Error('Empty project payload file');
    }
    return new Uint8Array(data);
  } finally {
    clearTimeout(timer);
  }
}

/** Supprime un fichier de charge utile (nettoyage après un échec), sans lever. */
export async function deletePayloadFile(pointer: string): Promise<void> {
  try {
    await storage.deleteFile(PROJECT_PAYLOADS_BUCKET_ID, payloadFileIdOf(pointer));
  } catch (error) {
    logger.projects.debug('Payload file cleanup skipped', pointer, error);
  }
}

/** Le fichier pointé existe-t-il encore ? `null` : impossible de le savoir (réseau…). */
export async function payloadFileExists(pointer: string): Promise<boolean | null> {
  try {
    await storage.getFile(PROJECT_PAYLOADS_BUCKET_ID, payloadFileIdOf(pointer));
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 404 ? false : null;
  }
}

function listProjectPayloadFiles(projectId: string) {
  return storage.listFiles(PROJECT_PAYLOADS_BUCKET_ID, [
    Query.equal('name', payloadFileName(projectId)),
    Query.limit(100),
  ]);
}

/**
 * Pointeur du plus récent fichier de charge utile du projet autre que
 * `missingPointer` : repli quand le fichier pointé par le document a disparu
 * (état laissé par une ancienne version de l'app, B3-1). `null` sinon.
 */
export async function latestPayloadPointerExcept(projectId: string, missingPointer: string): Promise<string | null> {
  const missingId = payloadFileIdOf(missingPointer);
  const res = await listProjectPayloadFiles(projectId);
  const candidates = res.files
    .filter((file) => file.$id !== missingId)
    .sort((a, b) => Date.parse(b.$createdAt) - Date.parse(a.$createdAt));
  return candidates.length > 0 ? toPayloadFilePointer(candidates[0].$id) : null;
}

/** Projet supprimé : tous ses fichiers de charge utile partent, sans lever. */
export async function deleteProjectPayloadFiles(projectId: string): Promise<void> {
  try {
    const res = await listProjectPayloadFiles(projectId);
    await Promise.allSettled(res.files.map((file) => storage.deleteFile(PROJECT_PAYLOADS_BUCKET_ID, file.$id)));
  } catch (error) {
    logger.projects.debug('Payload files delete skipped', projectId, error);
  }
}

/**
 * Supprime les anciens fichiers de charge utile d'un projet, après une
 * écriture confirmée du document à l'instant `writtenAt` (son `$updatedAt`) :
 * seulement ceux créés AVANT cette écriture, jamais celui que pointe
 * `keepPointer`. Un fichier créé après appartient à une sauvegarde plus
 * récente d'un autre onglet ou appareil, pas encore écrite dans le document :
 * le supprimer laisserait ce document pointer sur un fichier absent (B3-1).
 * Un fichier antérieur est, lui, celui d'une écriture déjà remplacée, ou d'une
 * écriture concurrente qui sera refusée (conflit) et le supprimera elle-même.
 * Sans lever : un fichier orphelin sera repris à la sauvegarde suivante.
 * Bucket absent ou projet resté dans le document : liste vide, rien à faire.
 */
export async function pruneProjectPayloadFiles(
  projectId: string,
  keepPointer: string | null | undefined,
  writtenAt: string,
  /** Relu juste avant les suppressions : false (ligne réécrite depuis) = rien n'est supprimé. */
  stillCurrent: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  const keepId = keepPointer && isPayloadFilePointer(keepPointer) ? payloadFileIdOf(keepPointer) : null;
  const before = Date.parse(writtenAt);
  if (!Number.isFinite(before)) return false;
  try {
    const res = await listProjectPayloadFiles(projectId);
    const stale = res.files.filter((file) => file.$id !== keepId && !(Date.parse(file.$createdAt) >= before));
    if (stale.length > 0 && !(await stillCurrent())) return false;
    await Promise.allSettled(stale.map((file) => storage.deleteFile(PROJECT_PAYLOADS_BUCKET_ID, file.$id)));
    return true;
  } catch (error) {
    logger.projects.debug('Payload files prune skipped', projectId, error);
    return false;
  }
}
