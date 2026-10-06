import { createHash } from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { Client, Databases, ID, Permission, Query, Role, Storage, Teams } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

import {
  corroboratedOwnerId,
  fileReadableBy,
  grantsTeamWrite,
  isTeamShared,
  projectPayloadFileName,
  projectSnapshotFileName,
  projectTeamId,
} from '../project-access.mjs';

import { readStoredProject } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { SequencedBatch } from '../../src/features/collab/protocol.ts';
import {
  assertContiguous,
  ProjectNotFoundError,
  type AppendResult,
  type CheckpointWrite,
  type DurableState,
  type LoadedRoom,
  type ProjectAccess,
  type RoomCheckpoint,
  type RoomStorage,
} from './storage.ts';

/**
 * Stockage de production dans Appwrite (clé admin, serveur seulement) :
 *  - `projects.data` : document matérialisé, au format de l'application
 *    (`gz:` + base64, ou fichier du bucket `project-payloads` au-delà de
 *    12 M car.) — les lecteurs hors session le lisent comme avant ;
 *  - `projects.collab` : `{ v, seq, snapshotFile, dataHash }`, écrit dans la
 *    même requête que `data`. Le point de sauvegarde exact (fichier
 *    `<projet>.collab.gz`) fait foi tant qu'il est lisible : un projet partagé
 *    n'est écrit que par la salle, un `data` différent (`dataHash`) vient d'un
 *    client hors session (ancienne version de l'application) et est ignoré,
 *    avec un avertissement ; sans point de sauvegarde lisible, `data` sert ;
 *  - `project_journal` : un document par paquet de lots, d'id
 *    `<projet>_<séquence de début>` — deux serveurs ne peuvent pas écrire le
 *    même (409 : barrière).
 * Projet supprimé (404 au point de sauvegarde) : `ProjectNotFoundError` ;
 * `purgeRoom` efface alors journal et points de sauvegarde (clé admin : ni le
 * propriétaire ni les éditeurs ne peuvent les lire ou les supprimer).
 *
 * La ligne `projects` est écrite par le client (propriétaire) : la clé admin ne
 * suit jamais un de ses pointeurs vers un fichier qui n'est pas celui du
 * projet. Charge utile `file:` : nommée `<projet>.json.gz` et lisible par le
 * propriétaire ou l'équipe ; point de sauvegarde : nommé `<projet>.collab.gz`
 * et sans aucune permission (écrit par ce serveur seulement). Propriétaire et
 * équipe : server/project-access.mjs.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const PROJECTS_COLLECTION_ID = 'projects';
const JOURNAL_COLLECTION_ID = 'project_journal';
const PAYLOADS_BUCKET_ID = 'project-payloads';
/** Limite du nginx devant Appwrite pour un attribut (cf. shared/utils/projects/limits.ts). */
const MAX_INLINE_PAYLOAD_CHARS = 12_000_000;
const MAX_JOURNAL_INLINE_CHARS = 10_000_000;
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
const FILE_PREFIX = 'file:';
const GZ_PREFIX = 'gz:';
const COLLAB_META_VERSION = 1;
/** Propriétaire et équipe d'un projet gardés en mémoire (vidés par la révocation : `forgetAccess`). */
const ACCESS_CACHE_MS = 10_000;

interface CollabMeta {
  v: number;
  seq: number;
  snapshotFile: string;
  dataHash: string;
}

export interface AppwriteStorageOptions {
  endpoint: string;
  projectId: string;
  apiKey: string;
  databaseId: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function journalDocumentId(projectId: string, startSeq: number): string {
  const id = `${projectId}_${startSeq.toString(36)}`;
  return id.length <= 36 ? id : `${sha256(projectId).slice(0, 24)}_${startSeq.toString(36)}`;
}

async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const raw = await gunzipAsync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  return JSON.parse(raw.toString('utf8'));
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Absence confirmée par Appwrite lui-même (`type` de l'erreur, ex.
 * `document_not_found`). Un 404 sans type vient d'un proxy sans route : pendant
 * un redémarrage d'Appwrite, son Traefik répond « 404 page not found » en
 * texte brut. Le prendre pour un projet supprimé fermait la salle en 4404 et
 * lançait la purge de son journal (vu le 2026-10-05) : c'est une panne
 * passagère, à réessayer.
 */
function isAppwriteNotFound(error: unknown, type: 'document_not_found' | 'storage_file_not_found'): boolean {
  return errorCode(error) === 404 && (error as { type?: unknown } | null)?.type === type;
}

export function createAppwriteStorage(options: AppwriteStorageOptions): RoomStorage {
  const client = new Client().setEndpoint(options.endpoint).setProject(options.projectId).setKey(options.apiKey);
  const databases = new Databases(client);
  const storage = new Storage(client);
  const teams = new Teams(client);
  const db = options.databaseId;
  const accessCache = new Map<string, { value: ProjectAccess | null; at: number }>();

  async function downloadFile(fileId: string): Promise<Uint8Array> {
    return new Uint8Array(await storage.getFileDownload(PAYLOADS_BUCKET_ID, fileId));
  }

  /** Document de la ligne ; un pointeur `file:` n'est suivi que vers la charge utile du projet. */
  async function readData(projectId: string, data: unknown, projectAccess: ProjectAccess): Promise<unknown> {
    if (typeof data !== 'string') return data;
    if (data.startsWith(FILE_PREFIX)) {
      const fileId = data.slice(FILE_PREFIX.length);
      const file = await storage.getFile(PAYLOADS_BUCKET_ID, fileId);
      if (file.name !== projectPayloadFileName(projectId) || !fileReadableBy(file.$permissions, projectAccess.ownerId, projectAccess.teamId)) {
        throw new Error(`projet ${projectId} : la charge utile pointe un fichier étranger au projet (${fileId})`);
      }
      return gunzipJson(await downloadFile(fileId));
    }
    if (data.startsWith(GZ_PREFIX)) return gunzipJson(Buffer.from(data.slice(GZ_PREFIX.length), 'base64'));
    return JSON.parse(data);
  }

  /** Membre confirmé de l'équipe avec le rôle `owner` (donné par l'API de partage au premier partage). */
  async function hasOwnerRole(teamId: string, userId: string): Promise<boolean> {
    try {
      const list = await teams.listMemberships(teamId, [Query.equal('userId', userId), Query.limit(1)]);
      return list.memberships.some((membership) => membership.userId === userId && membership.confirm && membership.roles.includes('owner'));
    } catch (error) {
      if (errorCode(error) === 404) return false;
      throw error;
    }
  }

  /**
   * Propriétaire corroboré par les permissions de la ligne (sinon ''), équipe
   * `p<projectId>` si la ligne lui donne la lecture (sinon null). Ancien
   * format (équipe en écriture : un éditeur a pu réécrire `user_id`) : le
   * propriétaire doit aussi avoir le rôle `owner` dans l'équipe.
   */
  async function access(projectId: string): Promise<ProjectAccess | null> {
    const cached = accessCache.get(projectId);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_MS) return cached.value;
    let value: ProjectAccess | null;
    try {
      const row = await databases.getDocument(db, PROJECTS_COLLECTION_ID, projectId, [Query.select(['$id', '$permissions', 'user_id'])]);
      const rowAccess = { $id: projectId, $permissions: row.$permissions, user_id: row.user_id };
      const teamId = isTeamShared(rowAccess) ? projectTeamId(projectId) : null;
      let ownerId = corroboratedOwnerId(rowAccess) ?? '';
      if (ownerId && grantsTeamWrite(row.$permissions) && !(await hasOwnerRole(projectTeamId(projectId), ownerId))) ownerId = '';
      value = { ownerId, teamId };
    } catch (error) {
      if (!isAppwriteNotFound(error, 'document_not_found')) throw error;
      value = null;
    }
    accessCache.set(projectId, { value, at: Date.now() });
    return value;
  }

  async function filePermissions(projectId: string): Promise<string[]> {
    const owner = await access(projectId);
    if (!owner) throw new ProjectNotFoundError(projectId);
    const permissions = owner.ownerId
      ? [
          Permission.read(Role.user(owner.ownerId)),
          Permission.update(Role.user(owner.ownerId)),
          Permission.delete(Role.user(owner.ownerId)),
        ]
      : [];
    if (owner.teamId) permissions.push(Permission.read(Role.team(owner.teamId)));
    return permissions;
  }

  async function uploadGzip(name: string, bytes: Uint8Array, permissions: string[]): Promise<string> {
    const file = await storage.createFile(PAYLOADS_BUCKET_ID, ID.unique(), InputFile.fromBuffer(bytes, name), permissions);
    return file.$id;
  }

  /** Supprime les fichiers `name` du projet sauf `keepId`, sans lever. */
  async function pruneFiles(name: string, keepId: string | null): Promise<void> {
    try {
      const list = await storage.listFiles(PAYLOADS_BUCKET_ID, [Query.equal('name', name), Query.limit(100)]);
      await Promise.allSettled(list.files.filter((file) => file.$id !== keepId).map((file) => storage.deleteFile(PAYLOADS_BUCKET_ID, file.$id)));
    } catch (error) {
      console.warn('[multiplayer] nettoyage des fichiers ignoré', name, error);
    }
  }

  async function listJournal(projectId: string, filter: string[]): Promise<Array<{ $id: string; start_seq: number; end_seq: number; payload: string }>> {
    const rows: Array<{ $id: string; start_seq: number; end_seq: number; payload: string }> = [];
    let cursor: string | null = null;
    for (;;) {
      const queries = [Query.equal('project_id', projectId), ...filter, Query.orderAsc('start_seq'), Query.limit(100)];
      if (cursor) queries.push(Query.cursorAfter(cursor));
      const page = await databases.listDocuments(db, JOURNAL_COLLECTION_ID, queries);
      for (const row of page.documents) rows.push(row as unknown as { $id: string; start_seq: number; end_seq: number; payload: string });
      if (page.documents.length < 100) return rows;
      cursor = page.documents[page.documents.length - 1].$id;
    }
  }

  /** Ligne du projet (null : supprimé). */
  async function readRow(projectId: string, queries: string[] = []): Promise<Record<string, unknown> | null> {
    try {
      return await databases.getDocument(db, PROJECTS_COLLECTION_ID, projectId, queries) as unknown as Record<string, unknown>;
    } catch (error) {
      if (isAppwriteNotFound(error, 'document_not_found')) return null;
      throw error;
    }
  }

  /** Lots journalisés au-delà de `seq`, triés. */
  async function readJournalAfter(projectId: string, seq: number): Promise<SequencedBatch[]> {
    const rows = await listJournal(projectId, [Query.greaterThan('end_seq', seq)]);
    const batches = (await Promise.all(rows.map((entry) => decodeJournalPayload(entry.payload)))).flat();
    return batches.filter((batch) => batch.seq > seq).sort((a, b) => a.seq - b.seq);
  }

  async function decodeJournalPayload(payload: string): Promise<SequencedBatch[]> {
    const bytes = payload.startsWith(FILE_PREFIX)
      ? await downloadFile(payload.slice(FILE_PREFIX.length))
      : Buffer.from(payload, 'base64');
    return (await gunzipJson(bytes)) as SequencedBatch[];
  }

  /**
   * Point de sauvegarde exact, ou null s'il manque, ne correspond pas à sa
   * séquence, ou n'est pas un fichier de ce serveur pour ce projet (`collab`
   * est un attribut de la ligne : le propriétaire peut l'écrire).
   */
  async function readCheckpoint(projectId: string, meta: CollabMeta): Promise<RoomCheckpoint | null> {
    try {
      const file = await storage.getFile(PAYLOADS_BUCKET_ID, meta.snapshotFile);
      if (file.name !== projectSnapshotFileName(projectId) || file.$permissions.length > 0) {
        console.error(JSON.stringify({ level: 'error', service: 'multiplayer', message: 'point de sauvegarde étranger au projet : ignoré', projectId }));
        return null;
      }
      const checkpoint = (await gunzipJson(await downloadFile(meta.snapshotFile))) as RoomCheckpoint;
      if (checkpoint.seq === meta.seq) return checkpoint;
      console.warn(JSON.stringify({ level: 'warn', service: 'multiplayer', message: 'point de sauvegarde incohérent', projectId }));
    } catch (error) {
      if (!isAppwriteNotFound(error, 'storage_file_not_found')) throw error;
      console.warn(JSON.stringify({ level: 'warn', service: 'multiplayer', message: 'point de sauvegarde introuvable', projectId }));
    }
    return null;
  }

  return {
    kind: 'appwrite',
    access,

    async loadRoom(projectId: string): Promise<LoadedRoom | null> {
      const row = await readRow(projectId);
      if (!row) return null;
      const projectAccess = await access(projectId);
      if (!projectAccess) return null;
      const stored = readStoredProject(await readData(projectId, row.data, projectAccess));
      if (!stored) throw new Error(`projet ${projectId} : données illisibles`);
      const meta = parseMeta(row.collab);
      const checkpoint = meta ? await readCheckpoint(projectId, meta) : null;
      if (meta && checkpoint) {
        const dataMatches = typeof row.data === 'string' && sha256(row.data) === meta.dataHash;
        if (!dataMatches) {
          console.warn(JSON.stringify({
            level: 'warn',
            service: 'multiplayer',
            message: 'document réécrit hors de la salle : ignoré, le point de sauvegarde fait foi',
            projectId,
            seq: meta.seq,
          }));
        }
        const batches = await readJournalAfter(projectId, meta.seq);
        return { checkpoint, document: stored.document, baseSeq: meta.seq, journal: assertContiguous(batches, meta.seq) };
      }
      // Pas de point de sauvegarde valable (première session, ou document
      // réécrit hors session) : on repart du document, journal précédent écarté.
      const stale = await listJournal(projectId, []);
      await Promise.all(stale.map((entry) => databases.deleteDocument(db, JOURNAL_COLLECTION_ID, entry.$id)));
      const baseSeq = Math.max(meta?.seq ?? 0, ...stale.map((entry) => entry.end_seq)) + 1;
      return { checkpoint: null, document: stored.document, baseSeq, journal: [] };
    },

    async appendJournal(projectId: string, batches: readonly SequencedBatch[]): Promise<AppendResult> {
      if (batches.length === 0) return 'ok';
      const startSeq = batches[0].seq;
      const endSeq = batches[batches.length - 1].seq;
      const gzipped = await gzipAsync(JSON.stringify(batches));
      let payload = gzipped.toString('base64');
      let uploaded: string | null = null;
      if (payload.length > MAX_JOURNAL_INLINE_CHARS) {
        uploaded = await uploadGzip(`${projectId}.journal-${startSeq}.gz`, gzipped, []);
        payload = `${FILE_PREFIX}${uploaded}`;
      }
      try {
        await databases.createDocument(db, JOURNAL_COLLECTION_ID, journalDocumentId(projectId, startSeq), {
          project_id: projectId,
          start_seq: startSeq,
          end_seq: endSeq,
          payload,
        }, []);
        return 'ok';
      } catch (error) {
        if (uploaded) await storage.deleteFile(PAYLOADS_BUCKET_ID, uploaded).catch(() => undefined);
        if (errorCode(error) === 409) return 'conflict';
        throw error;
      }
    },

    async saveCheckpoint(projectId: string, { seq, checkpointJson, documentJson }: CheckpointWrite): Promise<void> {
      const permissions = await filePermissions(projectId);
      const documentGzip = await gzipAsync(documentJson);
      const inline = `${GZ_PREFIX}${documentGzip.toString('base64')}`;
      const uploads: string[] = [];
      let data = inline;
      if (inline.length > MAX_INLINE_PAYLOAD_CHARS) {
        const fileId = await uploadGzip(`${projectId}.json.gz`, documentGzip, permissions);
        uploads.push(fileId);
        data = `${FILE_PREFIX}${fileId}`;
      }
      const snapshotFile = await uploadGzip(`${projectId}.collab.gz`, await gzipAsync(checkpointJson), []);
      uploads.push(snapshotFile);
      const meta: CollabMeta = { v: COLLAB_META_VERSION, seq, snapshotFile, dataHash: sha256(data) };
      try {
        await databases.updateDocument(db, PROJECTS_COLLECTION_ID, projectId, {
          data,
          size_bytes: Buffer.byteLength(documentJson, 'utf8'),
          collab: JSON.stringify(meta),
        });
      } catch (error) {
        await Promise.allSettled(uploads.map((fileId) => storage.deleteFile(PAYLOADS_BUCKET_ID, fileId)));
        if (isAppwriteNotFound(error, 'document_not_found')) {
          accessCache.delete(projectId);
          throw new ProjectNotFoundError(projectId);
        }
        throw error;
      }
      await pruneFiles(`${projectId}.collab.gz`, snapshotFile);
      await pruneFiles(`${projectId}.json.gz`, data.startsWith(FILE_PREFIX) ? data.slice(FILE_PREFIX.length) : null);
    },

    async pruneJournal(projectId: string, uptoSeq: number): Promise<void> {
      await deleteJournalRows(await listJournal(projectId, [Query.lessThanEqual('end_seq', uptoSeq)]));
    },

    async readDurable(projectId: string): Promise<DurableState | null> {
      const row = await readRow(projectId, [Query.select(['$id', 'collab'])]);
      const meta = row ? parseMeta(row.collab) : null;
      if (!meta) return null;
      const checkpoint = await readCheckpoint(projectId, meta);
      if (!checkpoint) return null;
      return { checkpoint, journal: await readJournalAfter(projectId, meta.seq) };
    },

    forgetAccess(projectId: string): void {
      accessCache.delete(projectId);
    },

    async purgeRoom(projectId: string): Promise<void> {
      accessCache.delete(projectId);
      await deleteJournalRows(await listJournal(projectId, []));
      await pruneFiles(`${projectId}.collab.gz`, null);
      await pruneFiles(`${projectId}.json.gz`, null);
    },
  };

  async function deleteJournalRows(rows: ReadonlyArray<{ $id: string; payload: string }>): Promise<void> {
    await Promise.allSettled(rows.map(async (entry) => {
      if (entry.payload.startsWith(FILE_PREFIX)) {
        await storage.deleteFile(PAYLOADS_BUCKET_ID, entry.payload.slice(FILE_PREFIX.length)).catch(() => undefined);
      }
      await databases.deleteDocument(db, JOURNAL_COLLECTION_ID, entry.$id);
    }));
  }
}

function parseMeta(value: unknown): CollabMeta | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const meta = JSON.parse(value) as CollabMeta;
    return meta?.v === COLLAB_META_VERSION && Number.isSafeInteger(meta.seq) && typeof meta.snapshotFile === 'string' && typeof meta.dataHash === 'string'
      ? meta
      : null;
  } catch {
    return null;
  }
}
