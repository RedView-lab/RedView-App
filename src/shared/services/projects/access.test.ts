import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lignes `projects` vraiment à l'utilisateur ou partagées avec lui
 * (access.ts) : une ligne d'un autre compte, lisible par tous et marquée
 * `user_id` = la victime, ne s'invite ni dans « Mes projets » ni dans
 * « Partagés avec moi », et ne s'ouvre pas.
 */

const teams = vi.hoisted(() => ({ ids: [] as string[], calls: 0 }));

vi.mock('@/shared/services/appwrite', () => ({
  client: {
    config: { endpoint: 'https://appwrite.test/v1' },
    async call(method: string, url: URL) {
      expect([method, url.pathname]).toEqual(['get', '/v1/teams']);
      teams.calls += 1;
      return { total: teams.ids.length, teams: teams.ids.map(($id) => ({ $id })) };
    },
  },
  Query: { limit: (n: number) => `limit(${n})`, cursorAfter: (id: string) => `cursorAfter(${id})` },
}));

const { isAccessibleDocument, isOwnDocument, sharingTeamOf } = await import('./access');
const { forgetMyProjectTeams } = await import('./accessQueries');

const me = 'victime';
const own = ['read("user:victime")', 'update("user:victime")', 'delete("user:victime")'];

beforeEach(() => {
  teams.ids = [];
  teams.calls = 0;
  forgetMyProjectTeams();
});

describe('lignes de projets accessibles', () => {
  it('ma ligne : user_id corroboré par une permission sur mon rôle', () => {
    expect(isOwnDocument({ $id: 'p1', user_id: me, $permissions: own }, me)).toBe(true);
  });

  it('ligne plantée par un autre compte (lisible par tous, user_id = moi) : pas à moi', () => {
    const planted = { $id: 'x1', user_id: me, $permissions: ['read("users")', 'update("users")', 'delete("user:attaquant")'] };
    expect(isOwnDocument(planted, me)).toBe(false);
    expect(isOwnDocument({ $id: 'x2', user_id: me, $permissions: ['read("user:victime2")'] }, me)).toBe(false);
  });

  it('partagée avec moi : équipe p<projet>, lecture accordée, et j’en suis membre', async () => {
    const shared = { $id: 'abc', user_id: 'owner', team_id: 'pabc', $permissions: ['read("user:owner")', 'read("team:pabc")'] };
    expect(sharingTeamOf(shared)).toBe('pabc');
    expect(await isAccessibleDocument(shared, me)).toBe(false);
    teams.ids = ['pabc'];
    // Équipe pas encore connue (invitation récente) : relue une fois.
    expect(await isAccessibleDocument(shared, me)).toBe(true);
  });

  it('team_id d’une autre équipe, ou équipe sans lecture accordée : jamais partagée', async () => {
    teams.ids = ['pautre', 'pabc'];
    expect(sharingTeamOf({ $id: 'abc', team_id: 'pautre', $permissions: ['read("team:pautre")'] })).toBeNull();
    expect(sharingTeamOf({ $id: 'abc', team_id: 'pabc', $permissions: ['read("users")'] })).toBeNull();
    expect(await isAccessibleDocument({ $id: 'abc', user_id: 'x', team_id: 'pabc', $permissions: ['read("any")'] }, me)).toBe(false);
  });
});
