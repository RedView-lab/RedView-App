import { createHash } from 'node:crypto';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { Client, Databases, ID, Permission, Query, Role, Storage } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';

import { readStoredProject } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import type { SequencedBatch } from '../../src/features/collab/protocol.ts';
import {
  assertContiguous,
  type AppendResult,
  type CheckpointWrite,
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

export function createAppwriteStorage(options: AppwriteStorageOptions): RoomStorage {
  const client = new Client().setEndpoint(options.endpoint).setProject(options.projectId).setKey(options.apiKey);
  const databases = new Databases(client);
  const storage = new Storage(client);
  const db = options.databaseId;
  const accessCache = new Map<string, { value: ProjectAccess | null; at: number }>();

  async function downloadFile(fileId: string): Promise<Uint8Array> {
    return new Uint8Array(await storage.getFileDownload(PAYLOADS_BUCKET_ID, fileId));
  }

  async function readData(data: unknown): Promise<unknown> {
    if (typeof data !== 'string') return data;
    if (data.startsWith(FILE_PREFIX)) return gunzipJson(await downloadFile(data.slice(FILE_PREFIX.length)));
    if (data.startsWith(GZ_PREFIX)) return gunzipJson(Buffer.from(data.slice(GZ_PREFIX.length), 'base64'));
    return JSON.parse(data);
  }

  async function access(projectId: string): Promise<ProjectAccess | null> {
    const cached = accessCache.get(projectId);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    let value: ProjectAccess | null;
    try {
      const row = await databases.getDocument(db, PROJECTS_COLLECTION_ID, projectId, [Query.select(['user_id', 'team_id'])]);
      value = { ownerId: String(row.user_id ?? ''), teamId: typeof row.team_id === 'string' && row.team_id ? row.team_id : null };
    } catch (error) {
      if (errorCode(error) !== 404) throw error;
      value = null;
    }
    accessCache.set(projectId, { value, at: Date.now() });
    return value;
  }

  async function filePermissions(projectId: string): Promise<string[]> {
    const owner = await access(projectId);
    if (!owner) return [];
    const permissions = [
      Permission.read(Role.user(owner.ownerId)),
      Permission.update(Role.user(owner.ownerId)),
      Permission.delete(Role.user(owner.ownerId)),
    ];
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

  async function decodeJournalPayload(payload: string): Promise<SequencedBatch[]> {
    const bytes = payload.startsWith(FILE_PREFIX)
      ? await downloadFile(payload.slice(FILE_PREFIX.length))
      : Buffer.from(payload, 'base64');
    return (await gunzipJson(bytes)) as SequencedBatch[];
  }

  /** Point de sauvegarde exact, ou null s'il manque / ne correspond pas à sa séquence. */
  async function readCheckpoint(projectId: string, meta: CollabMeta): Promise<RoomCheckpoint | null> {
    try {
      const checkpoint = (await gunzipJson(await downloadFile(meta.snapshotFile))) as RoomCheckpoint;
      if (checkpoint.seq === meta.seq) return checkpoint;
      console.warn(JSON.stringify({ level: 'warn', service: 'multiplayer', message: 'point de sauvegarde incohérent', projectId }));
    } catch (error) {
      if (errorCode(error) !== 404) throw error;
      console.warn(JSON.stringify({ level: 'warn', service: 'multiplayer', message: 'point de sauvegarde introuvable', projectId }));
    }
    return null;
  }

  return {
    kind: 'appwrite',
    access,

    async loadRoom(projectId: string): Promise<LoadedRoom | null> {
      let row: Record<string, unknown>;
      try {
        row = await databases.getDocument(db, PROJECTS_COLLECTION_ID, projectId) as unknown as Record<string, unknown>;
      } catch (error) {
        if (errorCode(error) === 404) return null;
        throw error;
      }
      const stored = readStoredProject(await readData(row.data));
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
        const rows = await listJournal(projectId, [Query.greaterThan('end_seq', meta.seq)]);
        const batches = (await Promise.all(rows.map((entry) => decodeJournalPayload(entry.payload)))).flat();
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
        throw error;
      }
      await pruneFiles(`${projectId}.collab.gz`, snapshotFile);
      await pruneFiles(`${projectId}.json.gz`, data.startsWith(FILE_PREFIX) ? data.slice(FILE_PREFIX.length) : null);
    },

    async pruneJournal(projectId: string, uptoSeq: number): Promise<void> {
      const rows = await listJournal(projectId, [Query.lessThanEqual('end_seq', uptoSeq)]);
      await Promise.allSettled(rows.map(async (entry) => {
        if (entry.payload.startsWith(FILE_PREFIX)) {
          await storage.deleteFile(PAYLOADS_BUCKET_ID, entry.payload.slice(FILE_PREFIX.length)).catch(() => undefined);
        }
        await databases.deleteDocument(db, JOURNAL_COLLECTION_ID, entry.$id);
      }));
    },
  };
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
