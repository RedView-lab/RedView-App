import { gzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson } from '../../src/features/itineraryPanel/lib/project/canonicalJson.ts';
import type { ProjectDocument } from '../../src/features/itineraryPanel/lib/project/layers.ts';
import { diffDocument } from '../../src/features/collab/model/diff.ts';
import { sampleDocument } from '../../src/features/collab/sim/fixtures.ts';
import type { ClientMessage, ServerMessage } from '../../src/features/collab/protocol.ts';
import type { HostedRoom } from './roomHost.ts';

/**
 * Stockage de production (appwriteStorage.ts) sur un faux `node-appwrite` en
 * mémoire : documents (id unique → 409, filtres de requête utilisés), fichiers
 * du bucket. Parcours complet avec un vrai RoomHost : première session,
 * journal, point de sauvegarde, reprise par un autre hôte, barrière entre deux
 * serveurs, document réécrit hors de la salle, point de sauvegarde perdu.
 */

type Doc = Record<string, unknown> & { $id: string };

const fake = vi.hoisted(() => ({
  collections: new Map<string, Map<string, Record<string, unknown> & { $id: string }>>(),
  files: new Map<string, { name: string; bytes: Uint8Array }>(),
  nextFile: 0,
}));

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  const error = (code: number) => Object.assign(new Error(`appwrite ${code}`), { code });
  const collection = (id: string) => {
    let docs = fake.collections.get(id);
    if (!docs) {
      docs = new Map();
      fake.collections.set(id, docs);
    }
    return docs;
  };
  const matches = (doc: Doc, raw: string) => {
    const query = JSON.parse(raw) as { method: string; attribute?: string; values?: unknown[] };
    const value = query.attribute ? doc[query.attribute] : undefined;
    switch (query.method) {
      case 'equal': return query.values!.includes(value);
      case 'greaterThan': return (value as number) > (query.values![0] as number);
      case 'lessThanEqual': return (value as number) <= (query.values![0] as number);
      default: return true;
    }
  };
  class Databases {
    async getDocument(_db: string, col: string, id: string) {
      const doc = collection(col).get(id);
      if (!doc) throw error(404);
      return { ...doc };
    }
    async listDocuments(_db: string, col: string, queries: string[] = []) {
      const parsed = queries.map((raw) => JSON.parse(raw) as { method: string; attribute?: string; values?: unknown[] });
      let docs = [...collection(col).values()].filter((doc) => queries.every((raw) => matches(doc, raw)));
      const order = parsed.find((query) => query.method === 'orderAsc');
      if (order) docs.sort((a, b) => (a[order.attribute!] as number) - (b[order.attribute!] as number));
      const cursor = parsed.find((query) => query.method === 'cursorAfter');
      if (cursor) docs = docs.slice(docs.findIndex((doc) => doc.$id === cursor.values![0]) + 1);
      const limit = parsed.find((query) => query.method === 'limit');
      docs = docs.slice(0, (limit?.values?.[0] as number) ?? 25);
      return { total: docs.length, documents: docs.map((doc) => ({ ...doc })) };
    }
    async createDocument(_db: string, col: string, id: string, data: Record<string, unknown>) {
      if (collection(col).has(id)) throw error(409);
      collection(col).set(id, { ...data, $id: id });
      return { ...data, $id: id };
    }
    async updateDocument(_db: string, col: string, id: string, data: Record<string, unknown>) {
      const doc = collection(col).get(id);
      if (!doc) throw error(404);
      Object.assign(doc, data);
      return { ...doc };
    }
    async deleteDocument(_db: string, col: string, id: string) {
      if (!collection(col).delete(id)) throw error(404);
      return {};
    }
  }
  class Storage {
    async createFile(_bucket: string, _id: string, file: { name: string; bytes: Uint8Array }) {
      const $id = `file${(fake.nextFile += 1)}`;
      fake.files.set($id, { name: file.name, bytes: file.bytes });
      return { $id };
    }
    async getFileDownload(_bucket: string, id: string) {
      const file = fake.files.get(id);
      if (!file) throw error(404);
      return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
    }
    async deleteFile(_bucket: string, id: string) {
      if (!fake.files.delete(id)) throw error(404);
      return {};
    }
    async listFiles(_bucket: string, queries: string[] = []) {
      const name = (JSON.parse(queries[0]) as { values: string[] }).values[0];
      return { files: [...fake.files].filter(([, file]) => file.name === name).map(([$id]) => ({ $id })) };
    }
  }
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
    setKey() { return this; }
  }
  return { ...actual, Client, Databases, Storage };
});

vi.mock('node-appwrite/file', () => ({
  InputFile: { fromBuffer: (bytes: Uint8Array, name: string) => ({ bytes: new Uint8Array(bytes), name }) },
}));

const { createAppwriteStorage } = await import('./appwriteStorage.ts');
const { RoomHost } = await import('./roomHost.ts');

const PROJECT = 'proj1';
const options = { endpoint: 'http://appwrite', projectId: 'p', apiKey: 'k', databaseId: 'db' };

function seedProjectRow(document: ProjectDocument): void {
  fake.collections.set('projects', new Map([[PROJECT, {
    $id: PROJECT,
    user_id: 'owner',
    data: `gz:${gzipSync(JSON.stringify(document)).toString('base64')}`,
  }]]));
}

function newHost() {
  return new RoomHost({
    storage: createAppwriteStorage(options),
    journalFlushMs: 10,
    checkpointIntervalMs: 60_000,
    checkpointBatches: 3,
    idleUnloadMs: 60_000,
    log: () => undefined,
  });
}

/** Client minimal relié à la salle : renvoie la boîte de réception. */
function join(room: HostedRoom | null, clientId: string) {
  const inbox: ServerMessage[] = [];
  const handle = {
    peer: { clientId, userId: `u-${clientId}`, send: (message: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(message)) as ServerMessage) },
    close: () => undefined,
  };
  room!.attach(handle, { epoch: null, lastSeq: null });
  return { inbox, handle };
}

const waitFor = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function renameBatch(room: HostedRoom, clientSeq: number, name: string): ClientMessage {
  const prev = room.room.state.document();
  const next = { ...prev, itineraries: prev.itineraries.map((it) => (it.id === 'it-1' ? { ...it, name } : it)) } as ProjectDocument;
  const { ops, blobs } = diffDocument(room.room.state.store, prev, next);
  return { type: 'batch', clientSeq, ops, blobs: Object.fromEntries(blobs) };
}

beforeEach(() => {
  fake.collections.clear();
  fake.files.clear();
  seedProjectRow(sampleDocument(300));
});

describe('stockage Appwrite de la salle', () => {
  it('première session : point de sauvegarde immédiat, journal, reprise exacte par un autre serveur', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    // Point de sauvegarde initial : métadonnées et fichier exact, document au format de l'app.
    const row = fake.collections.get('projects')!.get(PROJECT)!;
    const meta = JSON.parse(row.collab as string) as { seq: number; snapshotFile: string };
    const base = room.room.state.seq;
    expect(meta.seq).toBe(base);
    expect(fake.files.get(meta.snapshotFile)?.name).toBe(`${PROJECT}.collab.gz`);
    expect(String(row.data).startsWith('gz:')).toBe(true);

    const { handle } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'Un'));
    room.handle(handle, renameBatch(room, 2, 'Deux'));
    await waitFor(() => (fake.collections.get('project_journal')?.size ?? 0) > 0 && room.room.durableSeq === base + 2, 'journal');

    // Arrêt brutal (rien de plus écrit) : un autre serveur reprend point de sauvegarde + journal.
    const other = newHost();
    const recovered = (await other.open(PROJECT))!;
    expect(recovered.room.state.seq).toBe(base + 2);
    expect(canonicalJson(recovered.room.state.document())).toBe(canonicalJson(room.room.state.document()));

    // Barrière : l'ancien serveur ne peut plus écrire le journal à la place du nouveau.
    const { handle: otherHandle } = join(recovered, 'b');
    recovered.handle(otherHandle, renameBatch(recovered, 1, 'Trois'));
    await waitFor(() => recovered.room.durableSeq === base + 3, 'journal du nouveau serveur');
    room.handle(handle, renameBatch(room, 3, 'Quatre'));
    await waitFor(() => room.closed, 'ancienne salle fermée');
    expect(host.metrics.fenced).toBe(1);

    await other.shutdown();
    await host.shutdown();
  });

  it('point de sauvegarde après N lots : journal élagué, document lisible par l’application', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    const base = room.room.state.seq;
    const { handle } = join(room, 'a');
    for (let seq = 1; seq <= 4; seq += 1) room.handle(handle, renameBatch(room, seq, `Nom ${seq}`));
    await waitFor(() => {
      const meta = JSON.parse(String(fake.collections.get('projects')!.get(PROJECT)!.collab)) as { seq: number };
      return meta.seq >= base + 3;
    }, 'point de sauvegarde');
    await waitFor(() => [...(fake.collections.get('project_journal')?.values() ?? [])].every((entry) => (entry.end_seq as number) > base + 3), 'élagage');
    const files = [...fake.files.values()].filter((file) => file.name === `${PROJECT}.collab.gz`);
    expect(files).toHaveLength(1);
    await host.shutdown();

    const reader = newHost();
    const reopened = (await reader.open(PROJECT))!;
    expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('Nom 4');
    await reader.shutdown();
  });

  it('document réécrit hors de la salle (ancien client) : le point de sauvegarde et le journal font foi', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    const { handle } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'En session'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    const seq = room.room.state.seq;
    await host.shutdown();

    const external = sampleDocument(100);
    (external.itineraries[1] as { name: string }).name = 'Réécrit ailleurs';
    fake.collections.get('projects')!.get(PROJECT)!.data = `gz:${gzipSync(JSON.stringify(external)).toString('base64')}`;

    const next = newHost();
    const reopened = (await next.open(PROJECT))!;
    expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('En session');
    expect(reopened.room.state.seq).toBe(seq);
    await next.shutdown();
  });

  it('point de sauvegarde introuvable : la salle repart du document enregistré', async () => {
    const host = newHost();
    await host.open(PROJECT);
    await host.shutdown();
    const meta = JSON.parse(String(fake.collections.get('projects')!.get(PROJECT)!.collab)) as { snapshotFile: string };
    fake.files.delete(meta.snapshotFile);
    const external = sampleDocument(100);
    (external.itineraries[1] as { name: string }).name = 'Document seul';
    fake.collections.get('projects')!.get(PROJECT)!.data = `gz:${gzipSync(JSON.stringify(external)).toString('base64')}`;

    const next = newHost();
    const reopened = (await next.open(PROJECT))!;
    expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('Document seul');
    await next.shutdown();
  });

  it('projet introuvable', async () => {
    const host = newHost();
    expect(await host.open('absent')).toBeNull();
    await host.shutdown();
  });
});
