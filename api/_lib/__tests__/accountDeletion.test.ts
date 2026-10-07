import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Suppression de compte (accountDeletion.ts) sur un faux `node-appwrite` en
 * mémoire : tout ce que le compte possède disparaît (projets, partages,
 * co-édition, fichiers y compris orphelins, vues, dossiers, facturation,
 * compte), rien de ce qui appartient aux autres n'est touché — même une ligne
 * qui porte son `user_id` sans lui appartenir —, et une purge interrompue
 * reprend où elle s'est arrêtée.
 */

type Doc = Record<string, unknown> & { $id: string; $permissions: string[] };
type StoredFile = { $id: string; name: string; $permissions: string[] };

const fake = vi.hoisted(() => ({
  collections: new Map<string, Map<string, Doc>>(),
  buckets: new Map<string, Map<string, StoredFile>>(),
  users: new Map<string, { $id: string; name: string; email: string; labels: string[]; status: boolean }>(),
  teams: new Map<string, Array<{ $id: string; userId: string; roles: string[] }>>(),
  missingCollections: new Set<string>(),
  failNextFileDelete: false,
  stripeDeleted: [] as string[],
  stripeError: null as null | { code: string },
  notified: [] as string[],
  nextId: 0,
}));

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  const error = (code: number) => Object.assign(new Error(`appwrite ${code}`), { code });
  const parse = (queries: string[] = []) => queries.map((raw) => JSON.parse(raw) as { method: string; attribute?: string; values?: unknown[] });
  /** equal / contains / limit / cursorAfter, dans l'ordre des ids comme Appwrite. */
  function applyQueries<T extends { $id: string }>(items: T[], queries: string[] = []): T[] {
    let result = [...items].sort((a, b) => a.$id.localeCompare(b.$id));
    let limit = 25;
    for (const query of parse(queries)) {
      if (query.method === 'equal') result = result.filter((item) => (item as Record<string, unknown>)[query.attribute!] === query.values![0]);
      if (query.method === 'limit') limit = query.values![0] as number;
      if (query.method === 'cursorAfter') {
        const index = result.findIndex((item) => item.$id === query.values![0]);
        result = result.slice(index + 1);
      }
    }
    return result.slice(0, limit);
  }
  const collection = (id: string) => {
    if (fake.missingCollections.has(id)) throw error(404);
    if (!fake.collections.has(id)) fake.collections.set(id, new Map());
    return fake.collections.get(id)!;
  };
  const bucket = (id: string) => {
    if (!fake.buckets.has(id)) fake.buckets.set(id, new Map());
    return fake.buckets.get(id)!;
  };
  class Databases {
    async getDocument(_db: string, col: string, id: string) {
      const doc = collection(col).get(id);
      if (!doc) throw error(404);
      return { ...doc, $permissions: [...doc.$permissions] };
    }
    async listDocuments(_db: string, col: string, queries: string[] = []) {
      const documents = applyQueries([...collection(col).values()], queries);
      return { total: documents.length, documents };
    }
    async createDocument(_db: string, col: string, id: string, data: Record<string, unknown>, permissions: string[] = []) {
      const table = collection(col);
      if (table.has(id)) throw error(409);
      table.set(id, { ...data, $id: id, $permissions: permissions });
      return table.get(id);
    }
    async updateDocument(_db: string, col: string, id: string, data: Record<string, unknown>) {
      const doc = collection(col).get(id);
      if (!doc) throw error(404);
      Object.assign(doc, data);
      return doc;
    }
    async deleteDocument(_db: string, col: string, id: string) {
      if (!collection(col).delete(id)) throw error(404);
      return {};
    }
  }
  class Users {
    async get(userId: string) {
      const user = fake.users.get(userId);
      if (!user) throw error(404);
      return { ...user, labels: [...user.labels] };
    }
    async updateLabels(userId: string, labels: string[]) {
      fake.users.get(userId)!.labels = labels;
      return {};
    }
    async updateStatus(userId: string, status: boolean) {
      fake.users.get(userId)!.status = status;
      return {};
    }
    async delete(userId: string) {
      if (!fake.users.delete(userId)) throw error(404);
      // Appwrite retire aussi ses appartenances aux équipes.
      for (const [teamId, memberships] of fake.teams) fake.teams.set(teamId, memberships.filter((m) => m.userId !== userId));
      return {};
    }
    async listMemberships(userId: string, queries: string[] = []) {
      const all = [...fake.teams].flatMap(([teamId, memberships]) =>
        memberships.filter((m) => m.userId === userId).map((m) => ({ ...m, teamId })));
      const memberships = applyQueries(all, queries);
      return { total: memberships.length, memberships };
    }
    async list() {
      return { total: 0, users: [] };
    }
  }
  class Teams {
    async get(teamId: string) {
      if (!fake.teams.has(teamId)) throw error(404);
      return { $id: teamId };
    }
    async delete(teamId: string) {
      if (!fake.teams.delete(teamId)) throw error(404);
      return {};
    }
    async listMemberships(teamId: string, queries: string[] = []) {
      const team = fake.teams.get(teamId);
      if (!team) throw error(404);
      const userId = parse(queries).find((q) => q.method === 'equal' && q.attribute === 'userId')?.values?.[0];
      const memberships = team
        .filter((m) => userId === undefined || m.userId === userId)
        .map((m) => ({ ...m, confirm: true, userName: '', userEmail: '' }));
      return { total: memberships.length, memberships };
    }
    async deleteMembership(teamId: string, membershipId: string) {
      const team = fake.teams.get(teamId);
      if (!team?.some((m) => m.$id === membershipId)) throw error(404);
      fake.teams.set(teamId, team.filter((m) => m.$id !== membershipId));
      return {};
    }
  }
  class Storage {
    async listFiles(bucketId: string, queries: string[] = []) {
      const name = parse(queries).find((q) => q.method === 'equal' && q.attribute === 'name')?.values?.[0];
      const files = applyQueries([...bucket(bucketId).values()].filter((file) => name === undefined || file.name === name), queries);
      return { total: files.length, files };
    }
    async deleteFile(bucketId: string, fileId: string) {
      if (fake.failNextFileDelete) {
        fake.failNextFileDelete = false;
        throw error(503);
      }
      if (!bucket(bucketId).delete(fileId)) throw error(404);
      return {};
    }
  }
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
    setKey() { return this; }
  }
  return { ...actual, Client, Databases, Users, Teams, Storage };
});

vi.mock('../stripe.js', () => ({
  getStripeServer: () => ({
    customers: {
      del: async (id: string) => {
        if (fake.stripeError) throw Object.assign(new Error('stripe'), fake.stripeError);
        fake.stripeDeleted.push(id);
        return { id, deleted: true };
      },
    },
  }),
}));

vi.mock('../multiplayerNotify.js', () => ({
  notifyProjectAccessChanged: async (projectId: string) => {
    fake.notified.push(projectId);
  },
}));

const { deleteAccount, DELETION_PENDING_LABEL } = await import('../accountDeletion.ts');
const { projectTeamId } = await import('../../../server/lib/project-access.mjs');

const own = (userId: string) => [`read("user:${userId}")`, `update("user:${userId}")`, `delete("user:${userId}")`];
const ALICE = 'alice';
const BOB = 'bob';

function setDoc(col: string, doc: Doc) {
  if (!fake.collections.has(col)) fake.collections.set(col, new Map());
  fake.collections.get(col)!.set(doc.$id, doc);
}
function setFile(bucketId: string, file: StoredFile) {
  if (!fake.buckets.has(bucketId)) fake.buckets.set(bucketId, new Map());
  fake.buckets.get(bucketId)!.set(file.$id, file);
}
const ids = (col: string) => [...(fake.collections.get(col)?.keys() ?? [])].sort();
const fileIds = (bucketId: string) => [...(fake.buckets.get(bucketId)?.keys() ?? [])].sort();

beforeEach(() => {
  vi.stubEnv('APPWRITE_API_KEY', 'test-key');
  fake.collections.clear();
  fake.buckets.clear();
  fake.teams.clear();
  fake.missingCollections.clear();
  fake.failNextFileDelete = false;
  fake.stripeDeleted = [];
  fake.stripeError = null;
  fake.notified = [];
  fake.users = new Map([
    [ALICE, { $id: ALICE, name: 'Alice', email: 'alice@example.test', labels: [], status: true }],
    [BOB, { $id: BOB, name: 'Bob', email: 'bob@example.test', labels: [], status: true }],
  ]);

  // Alice : un projet privé, un projet partagé avec Bob (co-édition en cours).
  setDoc('projects', { $id: 'a-private', $permissions: own(ALICE), user_id: ALICE, name: 'Privé' });
  const sharedTeam = projectTeamId('a-shared');
  setDoc('projects', { $id: 'a-shared', $permissions: [...own(ALICE), `read("team:${sharedTeam}")`], user_id: ALICE, team_id: sharedTeam, name: 'Partagé' });
  fake.teams.set(sharedTeam, [{ $id: 'm1', userId: ALICE, roles: ['owner'] }, { $id: 'm2', userId: BOB, roles: ['editor'] }]);
  setDoc('project_journal', { $id: 'a-shared_0', $permissions: [], project_id: 'a-shared', payload: 'file:journal-big' });
  setDoc('project_views', { $id: 'v-alice-shared', $permissions: own(ALICE), project_id: 'a-shared', user_id: ALICE });
  setDoc('project_views', { $id: 'v-bob-shared', $permissions: own(BOB), project_id: 'a-shared', user_id: BOB });
  setFile('project-payloads', { $id: 'journal-big', name: 'journal.gz', $permissions: [] });
  setFile('project-payloads', { $id: 'snap', name: 'a-shared.collab.gz', $permissions: [] });
  setFile('project-payloads', { $id: 'a-payload', name: 'a-private.json.gz', $permissions: own(ALICE) });
  setFile('project-thumbnails', { $id: 'a-private', name: 'thumb.webp', $permissions: own(ALICE) });
  setFile('itinerary-fit-files', { $id: 'a-fit', name: 'ride.fit', $permissions: own(ALICE) });
  // .fit retiré d'un projet mais resté dans le bucket : orphelin, à effacer aussi.
  setFile('itinerary-fit-files', { $id: 'a-orphan', name: 'old.fit', $permissions: own(ALICE) });
  setDoc('project_folders', { $id: 'a-folder', $permissions: own(ALICE), user_id: ALICE, name: 'Été' });

  // Bob : son projet partagé avec Alice (éditrice), ses fichiers et sa vue.
  const bobTeam = projectTeamId('b-shared');
  setDoc('projects', { $id: 'b-shared', $permissions: [...own(BOB), `read("team:${bobTeam}")`], user_id: BOB, team_id: bobTeam, name: 'De Bob' });
  fake.teams.set(bobTeam, [{ $id: 'm3', userId: BOB, roles: ['owner'] }, { $id: 'm4', userId: ALICE, roles: ['editor'] }]);
  setDoc('project_views', { $id: 'v-alice-bob', $permissions: own(ALICE), project_id: 'b-shared', user_id: ALICE });
  setDoc('project_views', { $id: 'v-bob-bob', $permissions: own(BOB), project_id: 'b-shared', user_id: BOB });
  setFile('itinerary-fit-files', { $id: 'b-fit', name: 'bob.fit', $permissions: [...own(BOB), `read("team:${bobTeam}")`] });
  setFile('project-thumbnails', { $id: 'b-shared', name: 'thumb.webp', $permissions: own(BOB) });
  // Ligne créée par Bob avec `user_id` = Alice : elle n'est pas à Alice, on n'y touche pas.
  setDoc('projects', { $id: 'forged', $permissions: own(BOB), user_id: ALICE, name: 'Piège' });
  setDoc('project_folders', { $id: 'forged-folder', $permissions: own(BOB), user_id: ALICE, name: 'Piège' });

  // Facturation d'Alice (lignes écrites par le serveur).
  setDoc('customers', { $id: ALICE, $permissions: [], user_id: ALICE, stripe_customer_id: 'cus_alice' });
  setDoc('subscriptions', { $id: 'sub_alice', $permissions: [], user_id: ALICE, status: 'active' });
  setDoc('subscriptions', { $id: 'sub_bob', $permissions: [], user_id: BOB, status: 'active' });
});

describe('suppression de compte', () => {
  it('efface tout ce que le compte possède et rien d’autre', async () => {
    const summary = await deleteAccount(ALICE);

    // Charges utiles et points de sauvegarde partent avec leur projet ; le parcours des buckets trouve le reste.
    expect(summary).toEqual({ projects: 2, sharedProjectsLeft: 1, files: 3, views: 1, folders: 1, billingDeleted: true });
    expect(ids('projects')).toEqual(['b-shared', 'forged']);
    expect(ids('project_journal')).toEqual([]);
    expect(ids('project_views')).toEqual(['v-bob-bob']);
    expect(ids('project_folders')).toEqual(['forged-folder']);
    expect(ids('customers')).toEqual([]);
    expect(ids('subscriptions')).toEqual(['sub_bob']);
    expect(fileIds('project-payloads')).toEqual([]);
    expect(fileIds('project-thumbnails')).toEqual(['b-shared']);
    expect(fileIds('itinerary-fit-files')).toEqual(['b-fit']);
    // Équipe du projet partagé supprimée ; Alice a quitté celle de Bob.
    expect(fake.teams.has(projectTeamId('a-shared'))).toBe(false);
    expect(fake.teams.get(projectTeamId('b-shared'))!.map((m) => m.userId)).toEqual([BOB]);
    // Le serveur temps réel ferme les salles concernées tout de suite.
    expect(fake.notified.sort()).toEqual(['a-private', 'a-shared', 'b-shared']);
    expect(fake.stripeDeleted).toEqual(['cus_alice']);
    expect(fake.users.has(ALICE)).toBe(false);
    expect(fake.users.has(BOB)).toBe(true);
    expect(fake.collections.get('account_deletions')!.get(ALICE)).toMatchObject({ user_id: ALICE, status: 'done' });
  });

  it('une purge interrompue laisse le compte bloqué et marqué, puis reprend où elle s’était arrêtée', async () => {
    fake.failNextFileDelete = true;
    await expect(deleteAccount(ALICE)).rejects.toMatchObject({ code: 503 });
    const blocked = fake.users.get(ALICE)!;
    expect(blocked.status).toBe(false);
    expect(blocked.labels).toContain(DELETION_PENDING_LABEL);
    expect(fake.collections.get('account_deletions')!.get(ALICE)).toMatchObject({ status: 'pending' });

    await deleteAccount(ALICE);
    expect(ids('projects')).toEqual(['b-shared', 'forged']);
    expect(fake.users.has(ALICE)).toBe(false);
    expect(fileIds('itinerary-fit-files')).toEqual(['b-fit']);
    expect(fake.collections.get('account_deletions')!.get(ALICE)).toMatchObject({ status: 'done' });
  });

  it('la facturation passe en premier : une erreur Stripe arrête tout avant les projets', async () => {
    fake.stripeError = { code: 'api_connection_error' };
    await expect(deleteAccount(ALICE)).rejects.toThrow('stripe');
    expect(ids('projects')).toContain('a-private');
    // Client Stripe déjà supprimé ailleurs : rien à faire.
    fake.stripeError = { code: 'resource_missing' };
    await expect(deleteAccount(ALICE)).resolves.toMatchObject({ billingDeleted: true });
  });

  it('rejouée sur un compte déjà supprimé (restauration d’une sauvegarde), elle termine sans erreur', async () => {
    await deleteAccount(ALICE);
    await expect(deleteAccount(ALICE)).resolves.toEqual({
      projects: 0, sharedProjectsLeft: 0, files: 0, views: 0, folders: 0, billingDeleted: false,
    });
  });

  it('sans registre (collection pas encore créée), la suppression se fait quand même', async () => {
    fake.missingCollections.add('account_deletions');
    await deleteAccount(ALICE);
    expect(fake.users.has(ALICE)).toBe(false);
    expect(ids('projects')).toEqual(['b-shared', 'forged']);
  });
});
