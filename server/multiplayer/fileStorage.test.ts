import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import { createFileStorage } from './fileStorage.ts';
import { ProjectNotFoundError, type RoomCheckpoint } from './storage.ts';

/** Stockage de développement et des bancs : format, migration de l'ancien `room.json`, projet supprimé. */

let root: string;

const document = (name: string) => ({ schema: 2, name, savedAt: null, itineraries: [] }) as unknown as ProjectDocument;
const checkpoint = (seq: number): RoomCheckpoint => ({ seq, snapshot: { seq, objects: [], blobs: {} }, clientSeqs: { c1: seq } });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rv-file-storage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('stockage de fichiers', () => {
  it('projet créé par le premier client, point de sauvegarde écrit tel quel (sans être relu)', async () => {
    const storage = createFileStorage(root, 'owner-1');
    expect(await storage.loadRoom('p1')).toBeNull();
    const loaded = await storage.loadRoom('p1', document('Tour'));
    expect(loaded).toMatchObject({ checkpoint: null, document: { name: 'Tour' }, journal: [] });
    expect(await storage.access('p1')).toEqual({ ownerId: 'owner-1', teamId: null });

    // Texte arbitraire : le stockage ne le parse pas à l'écriture.
    const checkpointJson = JSON.stringify(checkpoint(3));
    const documentJson = JSON.stringify(document('Tour du Mont-Blanc'));
    await storage.saveCheckpoint('p1', { seq: 3, checkpointJson, documentJson });
    expect(await readFile(path.join(root, 'p1', 'checkpoint.json'), 'utf8')).toBe(checkpointJson);
    expect(await readFile(path.join(root, 'p1', 'document.json'), 'utf8')).toBe(documentJson);

    const reopened = createFileStorage(root, 'owner-1');
    // Point de sauvegarde valable : le document n'est pas relu.
    const reloaded = await reopened.loadRoom('p1');
    expect(reloaded).toMatchObject({ checkpoint: { seq: 3 } });
    expect(reloaded).not.toHaveProperty('document');
    expect((await reopened.readDurable('p1'))?.checkpoint.seq).toBe(3);
  });

  it('ancien room.json : lu (propriétaire compris), puis remplacé au point de sauvegarde suivant', async () => {
    await mkdir(path.join(root, 'p2'), { recursive: true });
    await writeFile(path.join(root, 'p2', 'room.json'), JSON.stringify({ checkpoint: checkpoint(5), document: document('Ancien'), ownerId: 'alice' }));
    const storage = createFileStorage(root);
    expect(await storage.access('p2')).toEqual({ ownerId: 'alice', teamId: null });
    expect(await storage.loadRoom('p2')).toMatchObject({ checkpoint: { seq: 5 } });
    expect((await storage.readDurable('p2'))?.checkpoint.seq).toBe(5);

    await storage.saveCheckpoint('p2', { seq: 6, checkpointJson: JSON.stringify(checkpoint(6)), documentJson: JSON.stringify(document('Nouveau')) });
    expect(existsSync(path.join(root, 'p2', 'room.json'))).toBe(false);
    const reopened = createFileStorage(root);
    expect(await reopened.access('p2')).toEqual({ ownerId: 'alice', teamId: null });
    expect(await reopened.loadRoom('p2')).toMatchObject({ checkpoint: { seq: 6 } });
    expect(JSON.parse(await readFile(path.join(root, 'p2', 'document.json'), 'utf8')).name).toBe('Nouveau');
  });

  it('sans point de sauvegarde : le document (ancien room.json compris)', async () => {
    await mkdir(path.join(root, 'p4'), { recursive: true });
    await writeFile(path.join(root, 'p4', 'room.json'), JSON.stringify({ checkpoint: null, document: document('Document seul'), ownerId: 'bob' }));
    expect(await createFileStorage(root).loadRoom('p4')).toMatchObject({ checkpoint: null, document: { name: 'Document seul' } });
  });

  it('dossier supprimé : projet introuvable au point de sauvegarde, jamais recréé', async () => {
    const storage = createFileStorage(root);
    await storage.loadRoom('p3', document('Éphémère'));
    await rm(path.join(root, 'p3'), { recursive: true, force: true });
    await expect(storage.saveCheckpoint('p3', { seq: 1, checkpointJson: '{}', documentJson: '{}' })).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(existsSync(path.join(root, 'p3'))).toBe(false);
  });
});
