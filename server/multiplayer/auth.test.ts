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
      return { $id: outcome.userId };
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

describe('serveur temps réel : jeton', () => {
  it('jeton valide : utilisateur, vérifié une fois par minute', async () => {
    const auth = authenticator();
    expect(await auth.verifyToken('jwt-a')).toBe('u1');
    expect(await auth.verifyToken('jwt-a')).toBe('u1');
    expect(fake.calls).toBe(1);
  });

  it('jeton refusé par Appwrite (401) : refusé', async () => {
    fake.outcomes = [{ code: 401 }];
    expect(await authenticator().verifyToken('jwt-b')).toBeNull();
  });

  it('panne passagère d’Appwrite (503, 429, réseau) : erreur à réessayer, jamais un refus gardé en cache', async () => {
    const auth = authenticator();
    fake.outcomes = [{ code: 503 }];
    await expect(auth.verifyToken('jwt-c')).rejects.toThrow('503');
    fake.outcomes = [{ code: 429 }];
    await expect(auth.verifyToken('jwt-c')).rejects.toThrow('429');
    // Appwrite revenu : le même jeton passe tout de suite.
    expect(await auth.verifyToken('jwt-c')).toBe('u1');
  });
});
