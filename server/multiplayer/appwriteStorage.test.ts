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
  files: new Map<string, { name: string; bytes: Uint8Array; permissions: string[] }>(),
  /** Équipes : rôles de chaque membre (`teamId` → `userId` → rôles). */
  teams: new Map<string, Map<string, string[]>>(),
  nextFile: 0,
  /** Appwrite en panne pour les mises à jour de documents (500). */
  failUpdates: false,
  /** Appwrite arrêté derrière son Traefik : tout appel répond 404 sans type (« 404 page not found »). */
  proxyNotFound: false,
  /** Appels reçus, dans l'ordre (`getDocument:<collection>:<attributs lus>`, `getFileDownload`…). */
  calls: [] as string[],
  /** Durée de chaque appel (ms) : un aller-retour vers Appwrite. */
  delayMs: 0,
}));

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  // Comme AppwriteException : un 404 d'Appwrite porte son type (`document_not_found`…), celui d'un proxy non.
  const error = (code: number, type = '') => Object.assign(new Error(`appwrite ${code}`), { code, type });
  const gate = async (call: string) => {
    fake.calls.push(call);
    if (fake.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    if (fake.proxyNotFound) throw error(404);
  };
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
    async getDocument(_db: string, col: string, id: string, queries: string[] = []) {
      // Comme Appwrite : `Query.select` ne renvoie que les attributs demandés.
      const select = queries.map((raw) => JSON.parse(raw) as { method: string; values?: string[] }).find((query) => query.method === 'select')?.values;
      await gate(`getDocument:${col}:${select ? select.join(',') : '*'}`);
      const doc = collection(col).get(id);
      if (!doc) throw error(404, 'document_not_found');
      return select ? Object.fromEntries(Object.entries(doc).filter(([key]) => key === '$id' || select.includes(key))) : { ...doc };
    }
    async listDocuments(_db: string, col: string, queries: string[] = []) {
      await gate(`listDocuments:${col}`);
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
      await gate(`createDocument:${col}`);
      if (collection(col).has(id)) throw error(409);
      collection(col).set(id, { ...data, $id: id });
      return { ...data, $id: id };
    }
    async updateDocument(_db: string, col: string, id: string, data: Record<string, unknown>) {
      await gate(`updateDocument:${col}`);
      if (fake.failUpdates) throw error(500);
      const doc = collection(col).get(id);
      if (!doc) throw error(404, 'document_not_found');
      Object.assign(doc, data);
      return { ...doc };
    }
    async deleteDocument(_db: string, col: string, id: string) {
      await gate(`deleteDocument:${col}`);
      if (!collection(col).delete(id)) throw error(404, 'document_not_found');
      return {};
    }
  }
  class Storage {
    async createFile(_bucket: string, _id: string, file: { name: string; bytes: Uint8Array }, permissions: string[] = []) {
      await gate('createFile');
      const $id = `file${(fake.nextFile += 1)}`;
      fake.files.set($id, { name: file.name, bytes: file.bytes, permissions: [...permissions] });
      return { $id };
    }
    async getFile(_bucket: string, id: string) {
      await gate('getFile');
      const file = fake.files.get(id);
      if (!file) throw error(404, 'storage_file_not_found');
      return { $id: id, name: file.name, $permissions: [...file.permissions] };
    }
    async getFileDownload(_bucket: string, id: string) {
      await gate('getFileDownload');
      const file = fake.files.get(id);
      if (!file) throw error(404, 'storage_file_not_found');
      return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
    }
    async deleteFile(_bucket: string, id: string) {
      await gate('deleteFile');
      if (!fake.files.delete(id)) throw error(404, 'storage_file_not_found');
      return {};
    }
    async listFiles(_bucket: string, queries: string[] = []) {
      const name = (JSON.parse(queries[0]) as { values: string[] }).values[0];
      return { files: [...fake.files].filter(([, file]) => file.name === name).map(([$id]) => ({ $id })) };
    }
  }
  class Teams {
    async listMemberships(teamId: string, queries: string[] = []) {
      await gate('listMemberships');
      const team = fake.teams.get(teamId);
      if (!team) throw error(404, 'team_not_found');
      const userId = (JSON.parse(queries[0] ?? '{}') as { values?: string[] }).values?.[0];
      const memberships = [...team].filter(([member]) => member === userId).map(([member, roles]) => ({ userId: member, roles, confirm: true }));
      return { total: memberships.length, memberships };
    }
  }
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
    setKey() { return this; }
  }
  return { ...actual, Client, Databases, Storage, Teams };
});

vi.mock('node-appwrite/file', () => ({
  InputFile: { fromBuffer: (bytes: Uint8Array, name: string) => ({ bytes: new Uint8Array(bytes), name }) },
}));

const { createAppwriteStorage } = await import('./appwriteStorage.ts');
const { RoomHost } = await import('./roomHost.ts');

const PROJECT = 'proj1';
const options = { endpoint: 'http://appwrite', projectId: 'p', apiKey: 'k', databaseId: 'db' };

const OWNER_PERMISSIONS = ['read("user:owner")', 'update("user:owner")', 'delete("user:owner")'];

function seedProjectRow(document: ProjectDocument): void {
  fake.collections.set('projects', new Map([[PROJECT, {
    $id: PROJECT,
    $permissions: OWNER_PERMISSIONS,
    user_id: 'owner',
    data: `gz:${gzipSync(JSON.stringify(document)).toString('base64')}`,
  }]]));
}

type LogEntry = { level: string; message: string; data?: Record<string, unknown> };

function newHost(overrides: Partial<ConstructorParameters<typeof RoomHost>[0]> = {}) {
  return new RoomHost({
    storage: createAppwriteStorage(options),
    journalFlushMs: 10,
    checkpointIntervalMs: 60_000,
    checkpointBatches: 3,
    idleUnloadMs: 60_000,
    shadowValidationIntervalMs: 0,
    // Entretien fréquent : les tests n'attendent pas le tour d'horloge d'une seconde de la production.
    maintenanceIntervalMs: 20,
    log: () => undefined,
    ...overrides,
  });
}

/** Client minimal relié à la salle : renvoie la boîte de réception et le code de fermeture. */
function join(room: HostedRoom | null, clientId: string) {
  const inbox: ServerMessage[] = [];
  const closed: { code: number | null } = { code: null };
  const handle = {
    peer: { clientId, userId: `u-${clientId}`, send: (message: ServerMessage) => inbox.push(JSON.parse(JSON.stringify(message)) as ServerMessage) },
    close: (code: number) => {
      closed.code = code;
    },
  };
  room!.attach(handle, { epoch: null, lastSeq: null });
  return { inbox, handle, closed };
}

const collabFiles = () => [...fake.files.values()].filter((file) => file.name === `${PROJECT}.collab.gz`);

const waitFor = async (condition: () => boolean, label: string) => {
  // Sous le délai du test (5 s) : un échec nomme l'étape qui attendait.
  const deadline = Date.now() + 4_000;
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
  fake.teams.clear();
  fake.failUpdates = false;
  fake.proxyNotFound = false;
  fake.calls = [];
  fake.delayMs = 0;
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

  it('barrière après élagage : un serveur dépassé reste refusé après le point de sauvegarde du nouveau', async () => {
    const old = newHost();
    const room = (await old.open(PROJECT))!;
    const { handle } = join(room, 'a');
    const base = room.room.state.seq;
    room.handle(handle, renameBatch(room, 1, 'Un'));
    await waitFor(() => room.room.durableSeq === base + 1, 'journal de l’ancien serveur');

    // Déploiement : le nouveau serveur reprend la salle, écrit, fait son point de sauvegarde et élague.
    const next = newHost();
    const recovered = (await next.open(PROJECT))!;
    const { handle: other } = join(recovered, 'b');
    for (let seq = 1; seq <= 3; seq += 1) recovered.handle(other, renameBatch(recovered, seq, `Nouveau ${seq}`));
    const journalStarts = () => [...(fake.collections.get('project_journal')?.values() ?? [])].map((row) => Number(row.start_seq));
    await waitFor(() => JSON.parse(String(fake.collections.get('projects')!.get(PROJECT)!.collab)).seq === base + 4, 'point de sauvegarde du nouveau');
    await waitFor(() => !journalStarts().includes(base + 1), 'journal de l’ancien élagué');
    // Son premier paquet reste : c'est la barrière.
    expect(journalStarts()).toContain(base + 2);

    // L'ancien serveur reçoit encore un lot : refusé (409), salle fermée, jamais confirmé durable.
    room.handle(handle, renameBatch(room, 2, 'Après la reprise'));
    await waitFor(() => room.closed, 'ancien serveur arrêté par la barrière');
    expect(old.metrics.fenced).toBe(1);
    expect(room.room.durableSeq).toBe(base + 1);
    await next.shutdown();
    await old.shutdown();
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

    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warnings.push(String(line));
    });
    try {
      const next = newHost();
      const reopened = (await next.open(PROJECT))!;
      expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('En session');
      expect(reopened.room.state.seq).toBe(seq);
      // Signalé après coup (le document est relu hors du chemin du `welcome`).
      await waitFor(() => warnings.some((line) => line.includes('document réécrit hors de la salle')), 'avertissement');
      await next.shutdown();
    } finally {
      warn.mockRestore();
    }
  });

  it('entrée dans une salle : trois allers-retours vers Appwrite, le document n’est relu qu’après coup', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    const { handle } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'Entrée rapide'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    await host.shutdown();

    fake.calls = [];
    fake.delayMs = 100;
    const next = newHost();
    const started = performance.now();
    const reopened = (await next.open(PROJECT))!;
    const elapsed = performance.now() - started;
    expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('Entrée rapide');
    // Ligne (sans `data`) ∥ droits → fichier du point de sauvegarde vérifié → téléchargé ∥ journal :
    // 3 × 100 ms ; l'ancien chemin en enchaînait 5 (ligne entière, droits, fichier, téléchargement, journal).
    expect(elapsed).toBeLessThan(450);
    const critical = fake.calls.slice(0, fake.calls.indexOf('getFileDownload') + 1);
    expect(critical.filter((call) => call.startsWith('getDocument:projects:'))).toEqual([
      'getDocument:projects:$id,collab',
      'getDocument:projects:$id,$permissions,user_id',
    ]);
    // Le document n'est lu qu'après le point de sauvegarde, pour le signalement seulement.
    expect(fake.calls.indexOf('getDocument:projects:$id,data')).toBeGreaterThan(fake.calls.indexOf('getFileDownload'));
    fake.delayMs = 0;
    await next.shutdown();
  });

  it('point de sauvegarde valable : le document n’est ni téléchargé ni lu (illisible, il ne bloque rien)', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    const { handle } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'Reprise rapide'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    await host.shutdown();
    // Document corrompu : avant, la salle ne se rechargeait plus (« données illisibles »).
    fake.collections.get('projects')!.get(PROJECT)!.data = 'gz:pas-du-gzip';

    const next = newHost();
    const reopened = (await next.open(PROJECT))!;
    expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('Reprise rapide');
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

  it('projet supprimé pendant la session : clients fermés (4404), journal et points de sauvegarde purgés, plus aucun essai', async () => {
    // Validation fantôme active : un projet supprimé n'est pas un écart.
    const host = newHost({ shadowValidationIntervalMs: 1 });
    const room = (await host.open(PROJECT))!;
    const { handle, closed } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'Un'));
    room.handle(handle, renameBatch(room, 2, 'Deux'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    expect(fake.collections.get('project_journal')!.size).toBeGreaterThan(0);

    // Le propriétaire supprime le projet ; le lot suivant déclenche le point de sauvegarde.
    fake.collections.get('projects')!.delete(PROJECT);
    room.handle(handle, renameBatch(room, 3, 'Trois'));
    await waitFor(() => room.closed, 'salle fermée');
    expect(closed.code).toBe(4404);
    await waitFor(() => (fake.collections.get('project_journal')?.size ?? 0) === 0 && collabFiles().length === 0, 'purge');
    expect(host.metrics.deletedRooms).toBe(1);
    expect(host.metrics.shadowMismatches).toBe(0);
    // Ni erreur comptée ni nouvel essai (la salle est oubliée).
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(host.metrics.checkpointErrors).toBe(0);
    expect(host.snapshotMetrics().rooms).toBe(0);
    await host.shutdown();
  });

  it('404 d’un proxy sans route (Appwrite en redémarrage) : panne passagère, salle ni fermée ni purgée', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    const { handle, closed } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'Avant'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    const journalRows = fake.collections.get('project_journal')!.size;

    fake.proxyNotFound = true;
    // La revérification des droits échoue (réessayée) au lieu de conclure « projet supprimé ».
    await expect(createAppwriteStorage(options).access(PROJECT)).rejects.toMatchObject({ code: 404 });
    for (let clientSeq = 2; clientSeq <= 4; clientSeq += 1) room.handle(handle, renameBatch(room, clientSeq, `Pendant ${clientSeq}`));
    await waitFor(() => host.metrics.journalErrors >= 1, 'journal en échec');
    expect(room.closed).toBe(false);
    expect(closed.code).toBeNull();
    expect(host.metrics.deletedRooms).toBe(0);
    expect(fake.collections.get('project_journal')!.size).toBeGreaterThanOrEqual(journalRows);

    fake.proxyNotFound = false;
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal rattrapé');
    expect(room.closed).toBe(false);
    await host.shutdown();
  });

  it('point de sauvegarde en échec : attente exponentielle, salle inactive déchargée dès que le journal est écrit', async () => {
    const logs: LogEntry[] = [];
    // Attentes réduites (20 ms → 40 ms…) : même loi qu'en production (1 s → 2 s…, 60 s au plus).
    const host = newHost({ checkpointIntervalMs: 20, checkpointRetryMinMs: 20, idleUnloadMs: 200, log: (level, message, data) => logs.push({ level, message, data }) });
    const room = (await host.open(PROJECT))!;
    const { handle } = join(room, 'a');
    fake.failUpdates = true;
    room.handle(handle, renameBatch(room, 1, 'Pendant la panne'));
    await waitFor(() => host.metrics.checkpointErrors >= 2, 'deux échecs');
    const failures = logs.filter((entry) => entry.message === 'point de sauvegarde en échec');
    // Première erreur signalée en erreur, les suivantes en avertissement, attente doublée.
    expect(failures.map((entry) => entry.level).slice(0, 2)).toEqual(['error', 'warn']);
    expect(failures.map((entry) => entry.data?.retryInMs).slice(0, 2)).toEqual([20, 40]);

    // Plus personne : déchargée sans attendre un point de sauvegarde réussi.
    room.detach(handle);
    await waitFor(() => room.closed, 'salle déchargée');
    expect(room.room.durableSeq).toBe(room.room.state.seq);

    // Reprise : dernier point de sauvegarde + journal.
    fake.failUpdates = false;
    const next = newHost();
    const reopened = (await next.open(PROJECT))!;
    expect((reopened.room.state.document().itineraries[1] as { name: string }).name).toBe('Pendant la panne');
    await next.shutdown();
    await host.shutdown();
  }, 15_000);

  it('validation fantôme : l’état durable rejoué égale la mémoire ; un paquet de journal perdu est signalé', async () => {
    const logs: LogEntry[] = [];
    const host = newHost({ shadowValidationIntervalMs: 1, log: (level, message, data) => logs.push({ level, message, data }) });
    const room = (await host.open(PROJECT))!;
    const { handle } = join(room, 'a');
    for (let seq = 1; seq <= 3; seq += 1) room.handle(handle, renameBatch(room, seq, `Nom ${seq}`));
    await waitFor(() => host.metrics.shadowChecks >= 1 && room.room.durableSeq === room.room.state.seq, 'première validation');
    expect(host.metrics.shadowMismatches).toBe(0);

    // Deux lots journalisés puis perdus par le stockage : la validation suivante le voit.
    room.handle(handle, renameBatch(room, 4, 'Nom 4'));
    room.handle(handle, renameBatch(room, 5, 'Nom 5'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    const journal = fake.collections.get('project_journal')!;
    for (const id of [...journal.keys()]) journal.delete(id);
    room.handle(handle, renameBatch(room, 6, 'Nom 6'));
    await waitFor(() => host.metrics.shadowMismatches === 1, 'écart signalé');
    expect(logs.some((entry) => entry.level === 'error' && entry.message.startsWith('validation fantôme'))).toBe(true);
    await host.shutdown();
  });

  it('état durable relu sans rien modifier, même sans point de sauvegarde lisible', async () => {
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    const { handle } = join(room, 'a');
    room.handle(handle, renameBatch(room, 1, 'Un'));
    await waitFor(() => room.room.durableSeq === room.room.state.seq, 'journal');
    await host.shutdown();
    const storage = createAppwriteStorage(options);
    const durable = await storage.readDurable(PROJECT);
    expect(durable?.journal.map((batch) => batch.clientSeq)).toEqual([1]);
    const meta = JSON.parse(String(fake.collections.get('projects')!.get(PROJECT)!.collab)) as { snapshotFile: string };
    fake.files.delete(meta.snapshotFile);
    const journalSize = fake.collections.get('project_journal')!.size;
    expect(await storage.readDurable(PROJECT)).toBeNull();
    expect(fake.collections.get('project_journal')!.size).toBe(journalSize);
  });
});

/**
 * La ligne `projects` est écrite par le client : ses pointeurs (`collab`,
 * `data: "file:…"`) et `user_id` ne doivent jamais mener la clé admin vers
 * les données d'un autre projet.
 */
describe('stockage Appwrite : pointeurs de la ligne réécrits par un client', () => {
  const putFile = (name: string, value: unknown, permissions: string[]) => {
    const $id = `file${(fake.nextFile += 1)}`;
    fake.files.set($id, { name, bytes: new Uint8Array(gzipSync(JSON.stringify(value))), permissions });
    return $id;
  };
  const victimCheckpoint = (objects: unknown[]) => ({ seq: 5, snapshot: { seq: 5, objects, blobs: {} }, clientSeqs: {} });
  const setRow = (fields: Record<string, unknown>) => Object.assign(fake.collections.get('projects')!.get(PROJECT)!, fields);

  it('point de sauvegarde d’un autre projet pointé par `collab` : ignoré, la salle repart de son propre document', async () => {
    const stolen = putFile('victim.collab.gz', victimCheckpoint([['p', null, null, null, [['name', 'SECRET-VICTIME']]]]), []);
    setRow({ collab: JSON.stringify({ v: 1, seq: 5, snapshotFile: stolen, dataHash: 'x' }) });
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    expect(room.room.state.document().name).toBe('Tour du Mont-Blanc');
    await host.shutdown();
  });

  it('point de sauvegarde au bon nom mais écrit par un client (avec permissions) : ignoré', async () => {
    const forged = putFile(`${PROJECT}.collab.gz`, victimCheckpoint([['p', null, null, null, [['name', 'FORGÉ']]]]), OWNER_PERMISSIONS);
    setRow({ collab: JSON.stringify({ v: 1, seq: 5, snapshotFile: forged, dataHash: 'x' }) });
    const host = newHost();
    const room = (await host.open(PROJECT))!;
    expect(room.room.state.document().name).toBe('Tour du Mont-Blanc');
    await host.shutdown();
  });

  it('charge utile `file:` d’un autre projet ou d’un autre compte : refusée', async () => {
    const victim = putFile('victim.json.gz', { schema: 2, name: 'SECRET', itineraries: [] }, ['read("user:victim")']);
    setRow({ data: `file:${victim}` });
    await expect(newHost().open(PROJECT)).rejects.toThrow(/étranger/);
    const renamed = putFile(`${PROJECT}.json.gz`, { schema: 2, name: 'SECRET', itineraries: [] }, ['read("user:victim")']);
    setRow({ data: `file:${renamed}` });
    await expect(newHost().open(PROJECT)).rejects.toThrow(/étranger/);
    const own = putFile(`${PROJECT}.json.gz`, { schema: 2, name: 'À moi', itineraries: [] }, OWNER_PERMISSIONS);
    setRow({ data: `file:${own}` });
    const host = newHost();
    expect((await host.open(PROJECT))!.room.state.document().name).toBe('À moi');
    await host.shutdown();
  });

  it('état complet en boucle (parents en cycle) : refusé, sans figer le serveur', async () => {
    const loop = putFile(`${PROJECT}.collab.gz`, victimCheckpoint([
      ['p', null, null, null, []],
      ['p/itineraries:a', 'p/itineraries:b', 'itineraries', 'a0', []],
      ['p/itineraries:b', 'p/itineraries:a', 'itineraries', 'a1', []],
    ]), []);
    setRow({ collab: JSON.stringify({ v: 1, seq: 5, snapshotFile: loop, dataHash: 'x' }) });
    await expect(newHost().open(PROJECT)).rejects.toThrow(/état complet invalide/);
  });

  it('ancien format (équipe en écriture) : un `user_id` réécrit par un éditeur n’en fait pas le propriétaire', async () => {
    setRow({ user_id: 'editor', $permissions: ['read("team:pproj1")', 'update("team:pproj1")', 'update("user:editor")'] });
    fake.teams.set('pproj1', new Map([['owner', ['owner']], ['editor', ['editor']]]));
    expect(await createAppwriteStorage(options).access(PROJECT)).toEqual({ ownerId: '', teamId: 'pproj1' });
    setRow({ user_id: 'owner', $permissions: ['read("team:pproj1")', 'update("team:pproj1")', ...OWNER_PERMISSIONS] });
    expect(await createAppwriteStorage(options).access(PROJECT)).toEqual({ ownerId: 'owner', teamId: 'pproj1' });
    // Format actuel (équipe en lecture seule) : `team_id` de la ligne ignoré, l'équipe est `p<projet>`.
    setRow({ team_id: 'pautre', $permissions: [...OWNER_PERMISSIONS, 'read("team:pproj1")'] });
    expect(await createAppwriteStorage(options).access(PROJECT)).toEqual({ ownerId: 'owner', teamId: 'pproj1' });
  });
});
