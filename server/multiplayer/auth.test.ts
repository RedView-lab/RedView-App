import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthenticator } from './auth.ts';
import type { RoomStorage } from './storage.ts';

/**
 * Vérification du jeton (JWT Appwrite) : un jeton refusé (401) n'entre pas,
 * mais une panne passagère d'Appwrite (réseau, 5xx, 429) n'est pas un refus —
 * sinon le client, après trois refus, se croit exclu de la session pour de bon.
 */

const fake = vi.hoisted(() => ({ outcomes: [] as Array<{ userId?: string; code?: number }>, calls: 0 }));

vi.mock('node-appwrite', async (importActual) => {
  const actual = await importActual<typeof import('node-appwrite')>();
  class Account {
    async get() {
      fake.calls += 1;
      const outcome = fake.outcomes.shift() ?? { userId: 'u1' };
      if (outcome.code) throw Object.assign(new Error(`appwrite ${outcome.code}`), { code: outcome.code });
      return { $id: outcome.userId, name: outcome.userId === 'u1' ? 'Alice' : '', email: `${outcome.userId}@example.test` };
    }
  }
  return { ...actual, Account };
});

const storage = { kind: 'appwrite', access: async () => ({ ownerId: 'u1', teamId: null }) } as unknown as RoomStorage;

function authenticator() {
  return createAuthenticator({ storage, appwrite: { endpoint: 'http://appwrite.test/v1', projectId: 'p', apiKey: 'k' }, devAuth: false });
}

beforeEach(() => {
  fake.outcomes = [];
  fake.calls = 0;
});

/** JWT de forme valide (signature non vérifiée ici : c'est Appwrite qui juge), expirant à `exp` (s). */
function jwt(label: string, exp = 2_000_000_000): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ userId: 'u1', sessionId: label, exp })}.${Buffer.from(label).toString('base64url')}`;
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
