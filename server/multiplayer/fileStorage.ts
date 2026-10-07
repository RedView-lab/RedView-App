import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
 * Stockage de développement et des bancs (un dossier par projet, un seul
 * processus) : `owner.json` (propriétaire), `checkpoint.json` (point de
 * sauvegarde exact), `document.json` (document au format de l'application) et
 * `journal.ndjson` (un lot par ligne). Comme le stockage Appwrite, un point de
 * sauvegarde écrit tels quels les JSON que la salle a déjà sérialisés, sans
 * les relire, et les droits ne lisent que le propriétaire (gardé en mémoire) :
 * l'ancien `room.json` tout-en-un était relu et réécrit en entier à chaque
 * point de sauvegarde, et relu à chaque vérification de droits — avec des
 * documents de 5 Mo, 43 % du temps du serveur sous charge partait là
 * (`bench:collab-load --route=60000`). Un `room.json` existant est encore lu,
 * puis remplacé au point de sauvegarde suivant.
 *
 * Les projets y sont créés par le premier client (`seed`) ; un dossier
 * supprimé est un projet supprimé (jamais recréé par un point de sauvegarde).
 */

interface LegacyRoomFile {
  checkpoint: RoomCheckpoint | null;
  document: ProjectDocument;
  ownerId: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function createFileStorage(root: string, ownerId = 'dev-user-001'): RoomStorage {
  const dirOf = (projectId: string) => {
    if (!SAFE_ID.test(projectId)) throw new Error(`id de projet invalide : ${projectId}`);
    return path.join(root, projectId);
  };
  /** Dernière séquence écrite par projet (barrière de journal, un seul processus). */
  const lastJournalSeq = new Map<string, number>();
  /** Propriétaire de chaque projet déjà lu (il ne change jamais). */
  const owners = new Map<string, string>();

  async function readText(projectId: string, name: string): Promise<string | null> {
    try {
      return await readFile(path.join(dirOf(projectId), name), 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function readJson<T>(projectId: string, name: string): Promise<T | null> {
    const text = await readText(projectId, name);
    return text === null ? null : (JSON.parse(text) as T);
  }

  /** Écriture atomique (fichier temporaire puis renommage) dans le dossier existant du projet. */
  async function writeText(projectId: string, name: string, text: string): Promise<void> {
    const target = path.join(dirOf(projectId), name);
    await writeFile(`${target}.tmp`, text);
    await rename(`${target}.tmp`, target);
  }

  /** Le projet existe : son propriétaire est écrit (le dossier seul ne suffit pas, le journal le recrée). */
  async function exists(projectId: string): Promise<boolean> {
    for (const name of ['owner.json', 'room.json']) {
      try {
        await stat(path.join(dirOf(projectId), name));
        return true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return false;
  }

  async function ownerOf(projectId: string): Promise<string | null> {
    const known = owners.get(projectId);
    if (known !== undefined) return known;
    const file = await readJson<{ ownerId: string }>(projectId, 'owner.json')
      ?? await readJson<LegacyRoomFile>(projectId, 'room.json');
    if (!file) return null;
    owners.set(projectId, file.ownerId ?? ownerId);
    return owners.get(projectId)!;
  }

  async function readCheckpoint(projectId: string): Promise<RoomCheckpoint | null> {
    return await readJson<RoomCheckpoint>(projectId, 'checkpoint.json')
      ?? (await readJson<LegacyRoomFile>(projectId, 'room.json'))?.checkpoint
      ?? null;
  }

  async function readJournal(projectId: string): Promise<SequencedBatch[]> {
    const text = await readText(projectId, 'journal.ndjson');
    return text === null ? [] : text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SequencedBatch);
  }

  return {
    kind: 'file',

    async access(projectId: string): Promise<ProjectAccess | null> {
      return { ownerId: (await ownerOf(projectId)) ?? ownerId, teamId: null };
    },

    async loadRoom(projectId: string, seed?: ProjectDocument): Promise<LoadedRoom | null> {
      // Le document n'est lu que sans point de sauvegarde (comme le stockage Appwrite).
      let checkpoint = await readJson<RoomCheckpoint>(projectId, 'checkpoint.json');
      let document = checkpoint ? null : await readJson<ProjectDocument>(projectId, 'document.json');
      if (!checkpoint && !document) {
        const legacy = await readJson<LegacyRoomFile>(projectId, 'room.json');
        if (legacy) {
          checkpoint = legacy.checkpoint;
          document = legacy.document;
          owners.set(projectId, legacy.ownerId ?? ownerId);
        }
      }
      if (!checkpoint && !document) {
        if (!seed) return null;
        await mkdir(dirOf(projectId), { recursive: true });
        await writeText(projectId, 'owner.json', JSON.stringify({ ownerId }));
        await writeText(projectId, 'document.json', JSON.stringify(seed));
        owners.set(projectId, ownerId);
        document = seed;
      }
      const afterSeq = checkpoint?.seq ?? 0;
      const journal = assertContiguous(await readJournal(projectId), afterSeq);
      lastJournalSeq.set(projectId, journal.length > 0 ? journal[journal.length - 1].seq : afterSeq);
      return checkpoint ? { checkpoint, baseSeq: 0, journal } : { checkpoint: null, document: document!, baseSeq: 0, journal };
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
      const owner = await ownerOf(projectId);
      if (owner === null || !(await exists(projectId))) throw new ProjectNotFoundError(projectId);
      try {
        // Ancien dossier (room.json) : le propriétaire passe dans son fichier, puis l'ancien format disparaît.
        await writeText(projectId, 'owner.json', JSON.stringify({ ownerId: owner }));
        // Le point de sauvegarde exact d'abord : il l'emporte toujours sur le document à la reprise.
        await writeText(projectId, 'checkpoint.json', checkpointJson);
        await writeText(projectId, 'document.json', documentJson);
        await rm(path.join(dirOf(projectId), 'room.json'), { force: true });
      } catch (error) {
        // Dossier supprimé pendant l'écriture : projet supprimé.
        if (isMissing(error)) throw new ProjectNotFoundError(projectId);
        throw error;
      }
    },

    // Un seul processus : la barrière est la séquence gardée en mémoire (`lastJournalSeq`),
    // aucun paquet n'est à garder pour elle (`keepStartSeq` ignoré).
    async pruneJournal(projectId: string, uptoSeq: number): Promise<void> {
      const kept = (await readJournal(projectId)).filter((batch) => batch.seq > uptoSeq);
      await writeText(projectId, 'journal.ndjson', kept.map((batch) => `${JSON.stringify(batch)}\n`).join(''));
    },

    async readDurable(projectId: string): Promise<DurableState | null> {
      const checkpoint = await readCheckpoint(projectId);
      if (!checkpoint) return null;
      const afterSeq = checkpoint.seq;
      const journal = (await readJournal(projectId)).filter((batch) => batch.seq > afterSeq).sort((a, b) => a.seq - b.seq);
      return { checkpoint, journal };
    },

    async purgeRoom(projectId: string): Promise<void> {
      lastJournalSeq.delete(projectId);
      owners.delete(projectId);
      await rm(dirOf(projectId), { recursive: true, force: true });
    },
  };
}
