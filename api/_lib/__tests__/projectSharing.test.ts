import { gzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Partage d'un projet (projectSharing.ts) sur un faux `node-appwrite` en
 * mémoire : qui peut inviter / retirer / quitter / lister, permissions données
 * à l'équipe (document, .fit, miniature), comptes inconnus refusés.
 */

const fake = vi.hoisted(() => ({
  projects: new Map<string, Record<string, unknown> & { $id: string; $permissions: string[] }>(),
  users: [] as Array<{ $id: string; email: string; name: string }>,
  teams: new Map<string, { name: string; memberships: Array<{ $id: string; userId: string; roles: string[] }> }>(),
  files: new Map<string, { name: string; $permissions: string[] }>(),
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
  }
  class Users {
    async list(queries: string[] = []) {
      const email = queryValue(queries, 'equal', 'email');
      return { total: 0, users: fake.users.filter((user) => user.email === email) };
    }
  }
  class Teams {
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
    async deleteMembership(teamId: string, membershipId: string) {
      const team = fake.teams.get(teamId)!;
      team.memberships = team.memberships.filter((membership) => membership.$id !== membershipId);
      return {};
    }
  }
  class Storage {
    async getFile(_bucket: string, fileId: string) {
      const file = fake.files.get(fileId);
      if (!file) throw error(404);
      return { $id: fileId, ...file, $permissions: [...file.$permissions] };
    }
    async updateFile(_bucket: string, fileId: string, _name?: string, permissions?: string[]) {
      const file = fake.files.get(fileId)!;
      if (permissions) file.$permissions = permissions;
      return file;
    }
  }
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
    setKey() { return this; }
  }
  return { ...actual, Client, Databases, Users, Teams, Storage };
});

const { getShareState, inviteToProject, leaveProject, projectTeamId, removeFromProject } = await import('../projectSharing.ts');
const { PublicError } = await import('../errors.ts');

const owner = { id: 'owner', email: 'owner@example.test' };
const editor = { id: 'editor', email: 'editor@example.test' };
const stranger = { id: 'stranger', email: 'stranger@example.test' };
const PROJECT = 'proj1';
const TEAM = projectTeamId(PROJECT);

beforeEach(() => {
  vi.stubEnv('APPWRITE_API_KEY', 'test-key');
  fake.projects.clear();
  fake.teams.clear();
  fake.files.clear();
  fake.users = [
    { $id: 'owner', email: 'owner@example.test', name: 'Owner' },
    { $id: 'editor', email: 'editor@example.test', name: 'Editor' },
    { $id: 'stranger', email: 'stranger@example.test', name: 'Stranger' },
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
    expect(row.$permissions).toEqual(expect.arrayContaining([`read("team:${TEAM}")`, `update("team:${TEAM}")`]));
    expect(row.$permissions.some((permission) => permission.startsWith('delete("team'))).toBe(false);
    expect(fake.files.get('fit1')!.$permissions).toContain(`read("team:${TEAM}")`);
    expect(fake.files.get(PROJECT)!.$permissions).toContain(`read("team:${TEAM}")`);
    // Une seconde invitation du même compte ne duplique rien.
    const again = await inviteToProject(owner, PROJECT, 'editor@example.test');
    expect(again.members).toHaveLength(2);
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
});
