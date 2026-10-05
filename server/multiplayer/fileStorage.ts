import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
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
 * Stockage de développement (un dossier par projet, un seul processus) :
 * `room.json` (point de sauvegarde exact + document) et `journal.ndjson` (un
 * lot par ligne). Les projets y sont créés par le premier client (`seed`) ;
 * un dossier supprimé est un projet supprimé.
 */

interface RoomFile {
  checkpoint: RoomCheckpoint | null;
  document: ProjectDocument;
  ownerId: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function createFileStorage(root: string, ownerId = 'dev-user-001'): RoomStorage {
  const dirOf = (projectId: string) => {
    if (!SAFE_ID.test(projectId)) throw new Error(`id de projet invalide : ${projectId}`);
    return path.join(root, projectId);
  };
  /** Dernière séquence écrite par projet (barrière de journal, un seul processus). */
  const lastJournalSeq = new Map<string, number>();

  async function readRoomFile(projectId: string): Promise<RoomFile | null> {
    try {
      return JSON.parse(await readFile(path.join(dirOf(projectId), 'room.json'), 'utf8')) as RoomFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeRoomFile(projectId: string, value: RoomFile): Promise<void> {
    const dir = dirOf(projectId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'room.json');
    await writeFile(`${target}.tmp`, JSON.stringify(value));
    await rename(`${target}.tmp`, target);
  }

  async function readJournal(projectId: string): Promise<SequencedBatch[]> {
    try {
      const text = await readFile(path.join(dirOf(projectId), 'journal.ndjson'), 'utf8');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SequencedBatch);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  return {
    kind: 'file',

    async access(projectId: string): Promise<ProjectAccess | null> {
      const file = await readRoomFile(projectId);
      return { ownerId: file?.ownerId ?? ownerId, teamId: null };
    },

    async loadRoom(projectId: string, seed?: ProjectDocument): Promise<LoadedRoom | null> {
      let file = await readRoomFile(projectId);
      if (!file) {
        if (!seed) return null;
        file = { checkpoint: null, document: seed, ownerId };
        await writeRoomFile(projectId, file);
      }
      const afterSeq = file.checkpoint?.seq ?? 0;
      const journal = assertContiguous(await readJournal(projectId), afterSeq);
      lastJournalSeq.set(projectId, journal.length > 0 ? journal[journal.length - 1].seq : afterSeq);
      return { checkpoint: file.checkpoint, document: file.document, baseSeq: 0, journal };
    },

    async appendJournal(projectId: string, batches: readonly SequencedBatch[]): Promise<AppendResult> {
      if (batches.length === 0) return 'ok';
      const last = lastJournalSeq.get(projectId) ?? 0;
      if (batches[0].seq !== last + 1) return 'conflict';
      const dir = dirOf(projectId);
      await mkdir(dir, { recursive: true });
      await appendFile(path.join(dir, 'journal.ndjson'), `${batches.map((batch) => JSON.stringify(batch)).join('\n')}\n`);
      lastJournalSeq.set(projectId, batches[batches.length - 1].seq);
      return 'ok';
    },

    async saveCheckpoint(projectId: string, { checkpointJson, documentJson }: CheckpointWrite): Promise<void> {
      const previous = await readRoomFile(projectId);
      if (!previous) throw new ProjectNotFoundError(projectId);
      const checkpoint = JSON.parse(checkpointJson) as RoomCheckpoint;
      const document = JSON.parse(documentJson) as ProjectDocument;
      await writeRoomFile(projectId, { checkpoint, document, ownerId: previous.ownerId ?? ownerId });
    },

    async pruneJournal(projectId: string, uptoSeq: number): Promise<void> {
      const kept = (await readJournal(projectId)).filter((batch) => batch.seq > uptoSeq);
      const target = path.join(dirOf(projectId), 'journal.ndjson');
      await writeFile(`${target}.tmp`, kept.map((batch) => `${JSON.stringify(batch)}\n`).join(''));
      await rename(`${target}.tmp`, target);
    },

    async readDurable(projectId: string): Promise<DurableState | null> {
      const file = await readRoomFile(projectId);
      if (!file?.checkpoint) return null;
      const afterSeq = file.checkpoint.seq;
      const journal = (await readJournal(projectId)).filter((batch) => batch.seq > afterSeq).sort((a, b) => a.seq - b.seq);
      return { checkpoint: file.checkpoint, journal };
    },

    async purgeRoom(projectId: string): Promise<void> {
      lastJournalSeq.delete(projectId);
      await rm(dirOf(projectId), { recursive: true, force: true });
    },
  };
}
