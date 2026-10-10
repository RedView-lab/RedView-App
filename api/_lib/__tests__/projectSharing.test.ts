import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Partage d'un projet (projectSharing.ts) sur un faux `node-appwrite` en
 * mémoire : qui peut inviter / retirer / quitter / lister / supprimer,
 * permissions données à l'équipe (document, .fit, miniature), comptes
 * inconnus refusés, données de la co-édition purgées à la suppression.
 */

const fake = vi.hoisted(() => ({
  projects: new Map<string, Record<string, unknown> & { $id: string; $permissions: string[] }>(),
  users: [] as Array<{ $id: string; email: string; name: string; emailVerification?: boolean; status?: boolean }>,
  teams: new Map<string, { name: string; memberships: Array<{ $id: string; userId: string; roles: string[] }> }>(),
  files: new Map<string, { name: string; $permissions: string[]; bytes?: Uint8Array }>(),
  journal: new Map<string, { $id: string; project_id: string; payload: string }>(),
  views: new Map<string, { $id: string; project_id: string }>(),
  /** Proxy sans route (Appwrite qui redémarre) : 404 sans type. */
  storageDown: false,
  nextId: 0,
}));

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  const error = (code: number) => Object.assign(new Error(`appwrite ${code}`), { code });
  const queryValue = (queries: string[], method: string, attribute: string) => {
    for (const raw of queries) {
      const query = JSON.parse(raw) as { method: string; attribute?: string; values?: unknown[] };
      if (query.method === method && query.attribute === attribute) return query.values?.[0];
    }
    return undefined;
  };
  class Databases {
    async getDocument(_db: string, _col: string, id: string) {
      const doc = fake.projects.get(id);
      if (!doc) throw error(404);
      return { ...doc, $permissions: [...doc.$permissions] };
    }
    async updateDocument(_db: string, _col: string, id: string, data: Record<string, unknown>, permissions?: string[]) {
      const doc = fake.projects.get(id);
      if (!doc) throw error(404);
      Object.assign(doc, data);
      if (permissions) doc.$permissions = permissions;
      return doc;
    }
    async listDocuments(_db: string, col: string, queries: string[] = []) {
      const table = col === 'project_journal' ? fake.journal : col === 'project_views' ? fake.views : null;
      if (!table) throw error(404);
      const projectId = queryValue(queries, 'equal', 'project_id');
      const documents = [...table.values()].filter((row) => row.project_id === projectId).slice(0, 100);
      return { total: documents.length, documents };
    }
    async deleteDocument(_db: string, col: string, id: string) {
      const table = col === 'project_journal' ? fake.journal : col === 'project_views' ? fake.views : fake.projects;
      if (!table.delete(id)) throw error(404);
      return {};
    }
  }
  class Users {
    async list(queries: string[] = []) {
      const email = queryValue(queries, 'equal', 'email');
      return { total: 0, users: fake.users.filter((user) => user.email === email) };
    }
  }
  class Teams {
    async delete(teamId: string) {
      if (!fake.teams.delete(teamId)) throw error(404);
      return {};
    }
    async get(teamId: string) {
      if (!fake.teams.has(teamId)) throw error(404);
      return { $id: teamId };
    }
    async create(teamId: string, name: string) {
      if (fake.teams.has(teamId)) throw error(409);
      fake.teams.set(teamId, { name, memberships: [] });
      return { $id: teamId };
    }
    async listMemberships(teamId: string, queries: string[] = []) {
      const team = fake.teams.get(teamId);
      if (!team) throw error(404);
      const userId = queryValue(queries, 'equal', 'userId');
      const memberships = team.memberships
        .filter((membership) => userId === undefined || membership.userId === userId)
        .map((membership) => {
          const user = fake.users.find((candidate) => candidate.$id === membership.userId);
          return { ...membership, confirm: true, userName: user?.name ?? '', userEmail: user?.email ?? '' };
        });
      return { total: memberships.length, memberships };
    }
    async createMembership(teamId: string, roles: string[], _email?: string, userId?: string) {
      const team = fake.teams.get(teamId);
      if (!team) throw error(404);
      if (team.memberships.some((membership) => membership.userId === userId)) throw error(409);
      const membership = { $id: `m${(fake.nextId += 1)}`, userId: userId!, roles };
      team.memberships.push(membership);
      return membership;
    }
    async updateMembership(teamId: string, membershipId: string, roles: string[]) {
      const membership = fake.teams.get(teamId)!.memberships.find((candidate) => candidate.$id === membershipId)!;
      membership.roles = roles;
      return membership;
    }
    async deleteMembership(teamId: string, membershipId: string) {
      const team = fake.teams.get(teamId)!;
      team.memberships = team.memberships.filter((membership) => membership.$id !== membershipId);
      return {};
    }
  }
  class Storage {
    async getFile(_bucket: string, fileId: string) {
      if (fake.storageDown) throw error(404);
      const file = fake.files.get(fileId);
      if (!file) throw Object.assign(error(404), { type: 'storage_file_not_found' });
      return { $id: fileId, ...file, $permissions: [...file.$permissions] };
    }
    async updateFile(_bucket: string, fileId: string, _name?: string, permissions?: string[]) {
      const file = fake.files.get(fileId)!;
      if (permissions) file.$permissions = permissions;
      return file;
    }
    async getFileDownload(_bucket: string, fileId: string) {
      const file = fake.files.get(fileId);
      if (!file?.bytes) throw error(404);
      return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
    }
    async listFiles(_bucket: string, queries: string[] = []) {
      const name = queryValue(queries, 'equal', 'name');
      return { total: 0, files: [...fake.files].filter(([, file]) => file.name === name).map(([$id]) => ({ $id })) };
    }
    async deleteFile(_bucket: string, fileId: string) {
      if (!fake.files.delete(fileId)) throw error(404);
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

const { deleteSharedProject, getShareState, inviteToProject, leaveProject, missingFitFiles, projectTeamId, removeFromProject } = await import('../projectSharing.ts');
const { PublicError } = await import('../errors.ts');

const owner = { id: 'owner', email: 'owner@example.test' };
const editor = { id: 'editor', email: 'editor@example.test' };
const stranger = { id: 'stranger', email: 'stranger@example.test' };
const PROJECT = 'proj1';
const OWNER_PERMISSIONS = ['read("user:owner")', 'update("user:owner")', 'delete("user:owner")'];
const TEAM = projectTeamId(PROJECT);

// Horloge avancée de 11 min à chaque test : les limites d'invitation (fenêtre de 10 min) repartent de zéro.
let clock = Date.UTC(2026, 9, 6);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 11 * 60_000;
  vi.setSystemTime(clock);
  vi.stubEnv('APPWRITE_API_KEY', 'test-key');
  fake.projects.clear();
  fake.teams.clear();
  fake.files.clear();
  fake.journal.clear();
  fake.views.clear();
  fake.users = [
    { $id: 'owner', email: 'owner@example.test', name: 'Owner', emailVerification: true, status: true },
    { $id: 'editor', email: 'editor@example.test', name: 'Editor', emailVerification: true, status: true },
    { $id: 'stranger', email: 'stranger@example.test', name: 'Stranger', emailVerification: true, status: true },
    { $id: 'unverified', email: 'unverified@example.test', name: 'Imposteur', emailVerification: false, status: true },
    { $id: 'blocked', email: 'blocked@example.test', name: 'Bloqué', emailVerification: true, status: false },
  ];
  const ownerPermissions = ['read("user:owner")', 'update("user:owner")', 'delete("user:owner")'];
  const document = { schema: 2, itineraries: [{ id: 'it-1', fitUploads: [{ name: 'ride.fit', path: 'fit1' }] }] };
  fake.projects.set(PROJECT, {
    $id: PROJECT,
    $permissions: ownerPermissions,
    user_id: 'owner',
    name: 'Tour',
    data: `gz:${gzipSync(JSON.stringify(document)).toString('base64')}`,
  });
  fake.files.set('fit1', { name: 'ride.fit', $permissions: ownerPermissions });
  fake.files.set(PROJECT, { name: 'thumb.webp', $permissions: ownerPermissions });
});

afterEach(() => {
  vi.useRealTimers();
});

const rejects = async (promise: Promise<unknown>, status: number) => {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(PublicError);
  expect((error as InstanceType<typeof PublicError>).status).toBe(status);
};

describe('partage d’un projet', () => {
  it('le propriétaire invite un compte existant : équipe, document et fichiers ouverts à l’équipe', async () => {
    const state = await inviteToProject(owner, PROJECT, ' Editor@Example.test ');
    expect(state.shared).toBe(true);
    expect(state.members.map((member) => [member.userId, member.role]).sort()).toEqual([['editor', 'editor'], ['owner', 'owner']]);
    const row = fake.projects.get(PROJECT)!;
    expect(row.team_id).toBe(TEAM);
    // L'équipe ne fait que lire : le document partagé est écrit par le serveur temps réel.
    expect([...row.$permissions].sort()).toEqual([
      'delete("user:owner")',
      `read("team:${TEAM}")`,
      'read("user:owner")',
      'update("user:owner")',
    ]);
    expect(fake.files.get('fit1')!.$permissions).toContain(`read("team:${TEAM}")`);
    expect(fake.files.get(PROJECT)!.$permissions).toContain(`read("team:${TEAM}")`);
    // Une seconde invitation du même compte ne duplique rien.
    const again = await inviteToProject(owner, PROJECT, 'editor@example.test');
    expect(again.members).toHaveLength(2);
  });

  it('gros projet (document dans la charge utile) : ses .fit s’ouvrent aussi à l’équipe', async () => {
    const document = { schema: 2, itineraries: [{ id: 'it-1', fitUploads: [{ name: 'big.fit', path: 'fitBig' }] }] };
    fake.files.set('fitBig', { name: 'big.fit', $permissions: OWNER_PERMISSIONS });
    fake.files.set('payload1', { name: `${PROJECT}.json.gz`, $permissions: OWNER_PERMISSIONS, bytes: gzipSync(JSON.stringify(document)) });
    fake.projects.get(PROJECT)!.data = 'file:payload1';
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    expect(fake.files.get('payload1')!.$permissions).toContain(`read("team:${TEAM}")`);
    expect(fake.files.get('fitBig')!.$permissions).toContain(`read("team:${TEAM}")`);
  });

  it('deux invitations lancées ensemble au premier partage : les deux invités restent membres', async () => {
    // Sans file par projet, la seconde voyait encore « premier partage » et
    // supprimait l'équipe que la première venait de créer, invité compris.
    await Promise.all([
      inviteToProject(owner, PROJECT, 'editor@example.test'),
      inviteToProject(owner, PROJECT, 'stranger@example.test'),
    ]);
    expect(fake.teams.get(TEAM)!.memberships.map((membership) => membership.userId).sort()).toEqual(['editor', 'owner', 'stranger']);
  });

  it('refus : e-mail inconnu, invitation par un éditeur, s’inviter soi-même, e-mail invalide', async () => {
    await rejects(inviteToProject(owner, PROJECT, 'nobody@example.test'), 404);
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    await rejects(inviteToProject(editor, PROJECT, 'stranger@example.test'), 403);
    await rejects(inviteToProject(owner, PROJECT, 'owner@example.test'), 400);
    await rejects(inviteToProject(owner, PROJECT, 'pas-un-email'), 400);
    await rejects(inviteToProject(owner, 'absent', 'editor@example.test'), 404);
  });

  it('liste : propriétaire et éditeurs seulement', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    expect((await getShareState(editor, PROJECT)).isOwner).toBe(false);
    expect((await getShareState(owner, PROJECT)).isOwner).toBe(true);
    await rejects(getShareState(stranger, PROJECT), 404);
  });

  it('retirer : propriétaire seulement ; quitter : éditeur seulement', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    await inviteToProject(owner, PROJECT, 'stranger@example.test');
    await rejects(removeFromProject(editor, PROJECT, 'stranger'), 403);
    await rejects(removeFromProject(owner, PROJECT, 'owner'), 400);
    const after = await removeFromProject(owner, PROJECT, 'stranger');
    expect(after.members.map((member) => member.userId).sort()).toEqual(['editor', 'owner']);
    await rejects(leaveProject(owner, PROJECT), 400);
    await leaveProject(editor, PROJECT);
    await rejects(getShareState(editor, PROJECT), 404);
    await rejects(leaveProject(stranger, PROJECT), 404);
  });

  it('supprimer un projet partagé : propriétaire seulement ; journal, points de sauvegarde, équipe et ligne effacés', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    fake.files.set('snap1', { name: `${PROJECT}.collab.gz`, $permissions: [] });
    fake.files.set('big1', { name: `${PROJECT}.journal-7.gz`, $permissions: [] });
    fake.files.set('other', { name: 'autre.collab.gz', $permissions: [] });
    fake.journal.set('j1', { $id: 'j1', project_id: PROJECT, payload: 'H4sI' });
    fake.journal.set('j2', { $id: 'j2', project_id: PROJECT, payload: 'file:big1' });
    fake.journal.set('j3', { $id: 'j3', project_id: 'autre', payload: 'H4sI' });

    await rejects(deleteSharedProject(editor, PROJECT), 403);
    expect(fake.projects.has(PROJECT)).toBe(true);

    await deleteSharedProject(owner, PROJECT);
    expect(fake.projects.has(PROJECT)).toBe(false);
    expect(fake.teams.has(TEAM)).toBe(false);
    expect([...fake.journal.keys()]).toEqual(['j3']);
    expect(fake.files.has('snap1') || fake.files.has('big1')).toBe(false);
    expect(fake.files.has('other')).toBe(true);
    // Déjà supprimé : rien à faire, pas d'erreur.
    await deleteSharedProject(owner, PROJECT);
  });

  it('supprimer un projet partagé efface les .fit des éditeurs (données de santé), jamais un fichier étranger au projet (A3-1)', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    // Sortie de l'éditeur ajoutée en session (lecture d'équipe), et un id étranger glissé dans le document.
    fake.files.set('fitB', { name: 'sortie-bob.fit', $permissions: ['read("user:editor")', 'update("user:editor")', 'delete("user:editor")', `read("team:${TEAM}")`] });
    fake.files.set('etranger', { name: 'autre.fit', $permissions: ['read("user:stranger")'] });
    const document = { schema: 2, itineraries: [{ id: 'it-1', fitUploads: [{ name: 'ride.fit', path: 'fit1' }, { name: 'b.fit', path: 'fitB' }, { name: 'x.fit', path: 'etranger' }] }] };
    fake.projects.get(PROJECT)!.data = `gz:${gzipSync(JSON.stringify(document)).toString('base64')}`;

    await deleteSharedProject(owner, PROJECT);
    expect(fake.files.has('fitB')).toBe(false);
    expect(fake.files.has('fit1')).toBe(false);
    expect(fake.files.has('etranger')).toBe(true);
  });
});

/**
 * Attaques sur le partage : attributs de la ligne réécrits par un client,
 * équipe créée d'avance, ids de fichiers étrangers glissés dans le document,
 * comptes non vérifiés, invitations en masse.
 */
describe('.fit introuvables d’un projet partagé', () => {
  it('un membre apprend lesquels n’existent plus ; un fichier illisible pour lui n’en fait pas partie', async () => {
    fake.storageDown = false;
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    fake.files.set('prive', { name: 'b.fit', $permissions: ['read("user:owner")'] });
    expect(await missingFitFiles(editor, PROJECT, ['fit1', 'prive', 'supprime'])).toEqual(['supprime']);
    expect(await missingFitFiles(owner, PROJECT, ['supprime', 'supprime'])).toEqual(['supprime']);
  });

  it('un .fit qui existe mais n’appartient pas au projet est répondu comme absent : pas de sondage d’autres comptes (A3-2)', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    fake.files.set('autrui', { name: 'autre.fit', $permissions: ['read("user:stranger")'] });
    expect(await missingFitFiles(editor, PROJECT, ['autrui', 'supprime'])).toEqual(['autrui', 'supprime']);
  });

  it('404 sans type (proxy pendant un redémarrage) : rien n’est déclaré supprimé', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    fake.storageDown = true;
    try {
      expect(await missingFitFiles(editor, PROJECT, ['supprime'])).toEqual([]);
    } finally {
      fake.storageDown = false;
    }
  });

  it('un compte hors du projet : 404 ; des ids invalides : 400', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    await rejects(missingFitFiles(stranger, PROJECT, ['supprime']), 404);
    await rejects(missingFitFiles(editor, PROJECT, ['../x']), 400);
    await rejects(missingFitFiles(editor, PROJECT, 'supprime'), 400);
    await rejects(missingFitFiles(editor, PROJECT, Array.from({ length: 201 }, (_, i) => `f${i}`)), 400);
  });
});

describe('partage d’un projet : attaques', () => {
  const ownerPermissions = ['read("user:owner")', 'update("user:owner")', 'delete("user:owner")'];

  it('éditeur qui réécrit user_id et ses permissions (ancien format : équipe en écriture) : toujours pas propriétaire', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    const row = fake.projects.get(PROJECT)!;
    // Ancienne ligne partagée : l'équipe pouvait écrire, l'éditeur s'est déclaré propriétaire.
    row.user_id = 'editor';
    row.$permissions = [`read("team:${TEAM}")`, `update("team:${TEAM}")`, 'update("user:editor")', 'delete("user:editor")'];
    await rejects(deleteSharedProject(editor, PROJECT), 403);
    await rejects(removeFromProject(editor, PROJECT, 'owner'), 403);
    await rejects(inviteToProject(editor, PROJECT, 'stranger@example.test'), 403);
    expect((await getShareState(editor, PROJECT)).isOwner).toBe(false);
    expect(fake.projects.has(PROJECT)).toBe(true);
    expect(fake.teams.get(TEAM)!.memberships.map((membership) => membership.userId).sort()).toEqual(['editor', 'owner']);
  });

  it('user_id d’un autre sans ses permissions : personne n’est propriétaire', async () => {
    fake.projects.get(PROJECT)!.user_id = 'stranger';
    await rejects(inviteToProject(stranger, PROJECT, 'editor@example.test'), 404);
    await rejects(deleteSharedProject(stranger, PROJECT), 404);
    expect(fake.teams.has(TEAM)).toBe(false);
  });

  it('team_id d’un autre projet sur sa propre ligne : l’équipe de la victime n’est ni listée, ni modifiée, ni supprimée', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    const attackerPermissions = ['read("user:stranger")', 'update("user:stranger")', 'delete("user:stranger")'];
    fake.projects.set('mine', { $id: 'mine', $permissions: attackerPermissions, user_id: 'stranger', team_id: TEAM, name: 'Piège' });
    const state = await getShareState(stranger, 'mine');
    expect(state.members).toEqual([]);
    await removeFromProject(stranger, 'mine', 'editor');
    await deleteSharedProject(stranger, 'mine');
    expect(fake.teams.get(TEAM)!.memberships.map((membership) => membership.userId).sort()).toEqual(['editor', 'owner']);
    expect(fake.projects.has(PROJECT)).toBe(true);
  });

  it('équipe p<id> créée d’avance par un inconnu : recréée au premier partage, l’inconnu n’y est plus', async () => {
    fake.teams.set(TEAM, { name: 'squat', memberships: [{ $id: 'm-squat', userId: 'stranger', roles: ['owner'] }] });
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    const members = fake.teams.get(TEAM)!.memberships;
    expect(members.map((membership) => membership.userId).sort()).toEqual(['editor', 'owner']);
    expect(members.find((membership) => membership.userId === 'owner')!.roles).toEqual(['owner']);
    // Partage suivant : l'équipe (la nôtre désormais) est gardée.
    await inviteToProject(owner, PROJECT, 'stranger@example.test');
    expect(fake.teams.get(TEAM)!.memberships.map((membership) => membership.userId).sort()).toEqual(['editor', 'owner', 'stranger']);
  });

  it('ids de fichiers étrangers dans le document : aucun droit accordé dessus', async () => {
    const victimPermissions = ['read("user:victim")', 'update("user:victim")', 'delete("user:victim")'];
    fake.files.set('victim-fit', { name: 'trace.fit', $permissions: victimPermissions });
    const document = { schema: 2, itineraries: [{ id: 'it-1', fitUploads: [{ path: 'fit1' }, { path: 'victim-fit' }] }] };
    fake.projects.get(PROJECT)!.data = JSON.stringify(document);
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    expect(fake.files.get('fit1')!.$permissions).toContain(`read("team:${TEAM}")`);
    expect(fake.files.get('victim-fit')!.$permissions).toEqual(victimPermissions);
  });

  it('charge utile pointant le fichier d’un autre projet, ou mal nommée : aucun droit accordé', async () => {
    fake.files.set('foreign', { name: 'autre.json.gz', $permissions: ['read("user:victim")'] });
    fake.files.set('renamed', { name: 'autre.json.gz', $permissions: ownerPermissions });
    fake.projects.get(PROJECT)!.data = 'file:foreign';
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    expect(fake.files.get('foreign')!.$permissions).toEqual(['read("user:victim")']);

    fake.projects.set('second', { $id: 'second', $permissions: ownerPermissions, user_id: 'owner', name: 'B', data: 'file:renamed' });
    await inviteToProject(owner, 'second', 'editor@example.test');
    expect(fake.files.get('renamed')!.$permissions).toEqual(ownerPermissions);
  });

  it('les fichiers ne s’ouvrent qu’au premier partage (le document est ensuite écrit par les éditeurs)', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    fake.files.set('fit2', { name: 'other.fit', $permissions: ownerPermissions });
    const document = { schema: 2, itineraries: [{ id: 'it-1', fitUploads: [{ path: 'fit2' }] }] };
    fake.projects.get(PROJECT)!.data = JSON.stringify(document);
    await inviteToProject(owner, PROJECT, 'stranger@example.test');
    expect(fake.files.get('fit2')!.$permissions).toEqual(ownerPermissions);
  });

  it('compte à l’e-mail non vérifié ou bloqué : comme s’il n’existait pas', async () => {
    await rejects(inviteToProject(owner, PROJECT, 'unverified@example.test'), 404);
    await rejects(inviteToProject(owner, PROJECT, 'blocked@example.test'), 404);
    expect(fake.teams.has(TEAM)).toBe(false);
  });

  it('invitations en masse : refusées au-delà de 20 par compte et par 10 minutes', async () => {
    const spammer = { id: 'spammer', email: 'spammer@example.test' };
    fake.projects.set('spam', { $id: 'spam', $permissions: ['read("user:spammer")', 'update("user:spammer")', 'delete("user:spammer")'], user_id: 'spammer', name: 'Spam' });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await inviteToProject(spammer, 'spam', `nobody${attempt}@example.test`).catch(() => undefined);
    }
    await rejects(inviteToProject(spammer, 'spam', 'editor@example.test'), 429);
  });

  it('retirer, quitter, supprimer : le serveur temps réel est prévenu (message signé)', async () => {
    vi.stubEnv('MULTIPLAYER_INTERNAL_SECRET', 'secret-de-test');
    vi.stubEnv('MULTIPLAYER_INTERNAL_URL', 'http://multiplayer.test/multiplayer/');
    const calls: Array<{ url: string; body: string; signature: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), signature: String((init.headers as Record<string, string>)['x-redview-signature']) });
      return new Response('{}', { status: 200 });
    });
    try {
      await inviteToProject(owner, PROJECT, 'editor@example.test');
      await inviteToProject(owner, PROJECT, 'stranger@example.test');
      await removeFromProject(owner, PROJECT, 'stranger');
      await leaveProject(editor, PROJECT);
      await deleteSharedProject(owner, PROJECT);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
    expect(calls).toHaveLength(3);
    const { createHmac } = await import('node:crypto');
    for (const call of calls) {
      expect(call.url).toBe('http://multiplayer.test/multiplayer/internal/access-changed');
      expect(JSON.parse(call.body).projectId).toBe(PROJECT);
      expect(call.signature).toBe(createHmac('sha256', 'secret-de-test').update(call.body).digest('hex'));
    }
  });

  it('supprimer : les vues des éditeurs sur ce projet sont effacées aussi', async () => {
    await inviteToProject(owner, PROJECT, 'editor@example.test');
    fake.views.set('v1', { $id: 'v1', project_id: PROJECT });
    fake.views.set('v2', { $id: 'v2', project_id: 'autre' });
    await deleteSharedProject(owner, PROJECT);
    expect([...fake.views.keys()]).toEqual(['v2']);
  });
});
