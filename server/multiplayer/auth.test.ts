import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthenticator } from './auth.ts';
import type { ProjectAccess, RoomStorage } from './storage.ts';

/**
 * Vérification du jeton (JWT Appwrite) : un jeton refusé (401) n'entre pas,
 * mais une panne passagère d'Appwrite (réseau, 5xx, 429) n'est pas un refus —
 * sinon le client, après trois refus, se croit exclu de la session pour de bon.
 */

const fake = vi.hoisted(() => ({
  outcomes: [] as Array<{ userId?: string; code?: number }>,
  calls: 0,
  /** Membres confirmés par équipe ; une équipe absente répond 404 (projet jamais partagé). */
  teams: new Map<string, string[]>(),
  membershipCalls: 0,
  membershipError: 0,
  /** Durée d'un aller-retour vers Appwrite (ms). */
  delayMs: 0,
  /** Allers-retours en cours, et leur maximum : 2 = ligne et appartenance lues en même temps. */
  inFlight: 0,
  maxInFlight: 0,
}));

/** Un aller-retour simulé vers Appwrite (durée `fake.delayMs`), compté tant qu'il est en cours. */
async function roundTrip(): Promise<void> {
  fake.inFlight += 1;
  fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
  try {
    if (fake.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
  } finally {
    fake.inFlight -= 1;
  }
}

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  const error = (code: number) => Object.assign(new Error(`appwrite ${code}`), { code });
  class Account {
    async get() {
      fake.calls += 1;
      const outcome = fake.outcomes.shift() ?? { userId: 'u1' };
      if (outcome.code) throw error(outcome.code);
      return { $id: outcome.userId, name: outcome.userId === 'u1' ? 'Alice' : '', email: `${outcome.userId}@example.test` };
    }
  }
  class Teams {
    async listMemberships(teamId: string, queries: string[] = []) {
      fake.membershipCalls += 1;
      await roundTrip();
      if (fake.membershipError) throw error(fake.membershipError);
      const members = fake.teams.get(teamId);
      if (!members) throw error(404);
      const userId = (JSON.parse(queries[0] ?? '{}') as { values?: string[] }).values?.[0];
      return { total: 1, memberships: members.filter((member) => member === userId).map((member) => ({ userId: member, confirm: true })) };
    }
  }
  return { ...actual, Account, Teams };
});

/** Ligne du projet telle que l'établit le stockage (propriétaire, équipe `p<projet>` si partagé). */
let projectAccess: ProjectAccess | null = { ownerId: 'u1', teamId: null };
const storage = {
  kind: 'appwrite',
  access: async () => {
    await roundTrip();
    return projectAccess;
  },
} as unknown as RoomStorage;

function authenticator({ devAuth = false } = {}) {
  return createAuthenticator({ storage, appwrite: { endpoint: 'http://appwrite.test/v1', projectId: 'p', apiKey: 'k' }, devAuth });
}

beforeEach(() => {
  fake.outcomes = [];
  fake.calls = 0;
  fake.teams = new Map();
  fake.membershipCalls = 0;
  fake.membershipError = 0;
  fake.delayMs = 0;
  fake.inFlight = 0;
  fake.maxInFlight = 0;
  projectAccess = { ownerId: 'u1', teamId: null };
});

/** JWT de forme valide (signature non vérifiée ici : c'est Appwrite qui juge), expirant à `exp` (s). */
function jwt(label: string, exp = 2_000_000_000, userId: unknown = 'u1'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ userId, sessionId: label, exp })}.${Buffer.from(label).toString('base64url')}`;
}

describe('serveur temps réel : jeton', () => {
  it('jeton valide : utilisateur, nom du compte et expiration du JWT, vérifié une fois par minute', async () => {
    const auth = authenticator();
    const token = jwt('a', 1_900_000_000);
    expect(await auth.verifyToken(token)).toEqual({ userId: 'u1', name: 'Alice', expiresAt: 1_900_000_000_000 });
    expect(await auth.verifyToken(token)).toMatchObject({ userId: 'u1' });
    expect(fake.calls).toBe(1);
  });

  it('nom vide : l’e-mail du compte le remplace (comme l’app)', async () => {
    fake.outcomes = [{ userId: 'u2' }];
    expect(await authenticator().verifyToken(jwt('e'))).toMatchObject({ userId: 'u2', name: 'u2@example.test' });
  });

  it('jeton refusé par Appwrite (401) : refusé', async () => {
    fake.outcomes = [{ code: 401 }];
    expect(await authenticator().verifyToken(jwt('b'))).toBeNull();
  });

  it('jeton qui n’a pas la forme d’un JWT : refusé sans appeler Appwrite', async () => {
    const auth = authenticator();
    expect(await auth.verifyToken('pas-un-jwt')).toBeNull();
    expect(await auth.verifyToken('dev:u1')).toBeNull();
    expect(await auth.verifyToken('x'.repeat(5_000))).toBeNull();
    expect(fake.calls).toBe(0);
  });

  it('panne passagère d’Appwrite (503, 429, réseau) : erreur à réessayer, jamais un refus gardé en cache', async () => {
    const auth = authenticator();
    const token = jwt('c');
    fake.outcomes = [{ code: 503 }];
    await expect(auth.verifyToken(token)).rejects.toThrow('503');
    fake.outcomes = [{ code: 429 }];
    await expect(auth.verifyToken(token)).rejects.toThrow('429');
    // Appwrite revenu : le même jeton passe tout de suite.
    expect(await auth.verifyToken(token)).toMatchObject({ userId: 'u1' });
  });
});

describe('serveur temps réel : droits à l’entrée dans une salle', () => {
  it('utilisateur déclaré par le jeton : lu sans vérification, rien pour un jeton illisible ou déjà refusé', async () => {
    const auth = authenticator();
    // Utilisateur jamais vérifié : pas de lecture anticipée (jeton forgé, A6-2).
    expect(auth.claimedUserId!(jwt('a0', 2_000_000_000, 'u7'))).toBeNull();
    fake.outcomes = [{ userId: 'u7' }];
    expect(await auth.verifyToken(jwt('a1', 2_000_000_000, 'u7'))).toMatchObject({ userId: 'u7' });
    expect(auth.claimedUserId!(jwt('a', 2_000_000_000, 'u7'))).toBe('u7');
    expect(auth.claimedUserId!(jwt('b', 2_000_000_000, '../u7'))).toBeNull();
    expect(auth.claimedUserId!(jwt('c', 2_000_000_000, 42))).toBeNull();
    expect(auth.claimedUserId!('pas-un-jwt')).toBeNull();
    expect(auth.claimedUserId!('dev:u1')).toBeNull();
    const refused = jwt('d', 2_000_000_000, 'u8');
    fake.outcomes = [{ code: 401 }];
    expect(await auth.verifyToken(refused)).toBeNull();
    expect(auth.claimedUserId!(refused)).toBeNull();
    expect(fake.calls).toBe(2);
    expect(authenticator({ devAuth: true }).claimedUserId!('dev:u9')).toBe('u9');
  });

  it('membre de l’équipe, sans cache : ligne et appartenance lues en même temps (un aller-retour)', async () => {
    projectAccess = { ownerId: 'owner', teamId: 'pproj1' };
    fake.teams.set('pproj1', ['u2']);
    fake.delayMs = 20;
    const auth = authenticator();
    // Compté, pas chronométré : sous la charge de `npm run check`, une mesure
    // de durée (< 150 ms pour deux appels de 80 ms) échouait sans régression.
    expect(await auth.checkAccess('u2', 'proj1', { fresh: true })).toBe('ok');
    expect(fake.maxInFlight).toBe(2);
    expect(await auth.checkAccess('u3', 'proj1', { fresh: true })).toBe('forbidden');
  });

  it('l’appartenance lue d’avance ne compte que si la ligne partage le projet avec cette équipe', async () => {
    // Équipe `pproj1` existante (n'importe qui peut en créer une), mais la ligne ne la nomme pas : refusé.
    fake.teams.set('pproj1', ['u2']);
    projectAccess = { ownerId: 'owner', teamId: null };
    const auth = authenticator();
    expect(await auth.checkAccess('u2', 'proj1', { fresh: true })).toBe('forbidden');
    // Projet jamais partagé : l'équipe n'existe pas (404) — le propriétaire entre, l'erreur ne compte pas.
    fake.teams.clear();
    projectAccess = { ownerId: 'u1', teamId: null };
    expect(await auth.checkAccess('u1', 'proj1', { fresh: true })).toBe('ok');
    expect(await auth.checkAccess('u2', 'proj1', { fresh: true })).toBe('forbidden');
    // Projet partagé et Appwrite en panne pour l'appartenance : erreur (à réessayer), jamais un refus.
    projectAccess = { ownerId: 'owner', teamId: 'pproj1' };
    fake.membershipError = 503;
    await expect(auth.checkAccess('u2', 'proj1', { fresh: true })).rejects.toThrow('503');
  });

  it('revérification périodique (avec cache) : rien de lu d’avance, le propriétaire ne coûte pas d’appartenance', async () => {
    const auth = authenticator();
    expect(await auth.checkAccess('u1', 'proj1')).toBe('ok');
    expect(fake.membershipCalls).toBe(0);
  });
});
