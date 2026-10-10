import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiRequest, ApiResponse } from '../types';

/**
 * Route de suppression du compte (A14-1, audit du 2026-10-10) : la purge
 * complète (tous les fichiers des trois buckets, chaque projet possédé…)
 * dépasse le délai du nginx de l'hôte (60 s) quand le service grandit. La
 * route répond donc 202 dès que le compte est bloqué et inscrit au registre,
 * et termine la purge en tâche de fond, avec reprises.
 */

const mocks = vi.hoisted(() => ({
  beginAccountDeletion: vi.fn<(userId: string) => Promise<{ exists: boolean }>>(),
  deleteAccount: vi.fn<(userId: string) => Promise<unknown>>(),
  listStalePendingDeletions: vi.fn<(now: number, olderThanMs: number) => Promise<string[]>>(),
  users: new Map<string, { $id: string; name: string; email: string }>(),
  sendAccountDeletedEmail: vi.fn(async () => true),
  captureServerError: vi.fn(),
}));

vi.mock('../accountDeletion', () => ({
  beginAccountDeletion: mocks.beginAccountDeletion,
  deleteAccount: mocks.deleteAccount,
  listStalePendingDeletions: mocks.listStalePendingDeletions,
}));
vi.mock('../appwrite', () => ({
  requireAuthenticatedUser: async () => ({ id: 'user-1', email: 'quelquun@example.test' }),
  getAppwriteUsers: () => ({
    get: async (userId: string) => {
      if (userId === 'user-1') return { $id: 'user-1', name: 'Quelqu’un' };
      const user = mocks.users.get(userId);
      if (!user) throw Object.assign(new Error('appwrite 404'), { code: 404 });
      return user;
    },
  }),
}));
vi.mock('../mailer', () => ({ sendAccountDeletedEmail: mocks.sendAccountDeletedEmail }));
vi.mock('../verificationStore', () => ({
  accountDeletionCodeKey: (email: string) => `delete:${email}`,
  consumeVerificationRequestQuota: () => {},
  releaseVerificationRequest: () => {},
  requestAccountDeletionCode: async () => ({ sent: true }),
  validateVerificationCode: () => ({ valid: true }),
}));
vi.mock('../../../server/lib/observability.mjs', () => ({ captureServerError: mocks.captureServerError }));

const { default: handler, resumePendingAccountDeletions } = await import('../../auth/delete-account');

interface Captured { status: number; body: unknown }

function confirm(): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader() { return res; },
    json(data: unknown) { captured.body = data; return res; },
    send(data: unknown) { captured.body = data; return res; },
    end() { return res; },
  } as unknown as ApiResponse;
  const req = {
    method: 'POST',
    url: '/api/auth/delete-account',
    query: {},
    headers: {},
    body: { action: 'confirm', code: '123456', confirm: 'delete-my-account' },
  } as unknown as ApiRequest;
  return Promise.resolve(handler(req, res)).then(() => captured);
}

/** Échoue au lieu d'attendre une réponse qui ne vient pas. */
function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`pas de réponse en ${ms} ms`)), ms)),
  ]);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('POST /api/auth/delete-account — confirm (A14-1)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.beginAccountDeletion.mockReset().mockResolvedValue({ exists: true });
    mocks.deleteAccount.mockReset();
    mocks.sendAccountDeletedEmail.mockClear();
    mocks.captureServerError.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('répond 202 dès le blocage, sans attendre la purge', async () => {
    let finishPurge!: () => void;
    mocks.deleteAccount.mockReturnValue(new Promise((resolve) => { finishPurge = () => resolve({}); }));

    const out = await within(confirm());

    expect(out.status).toBe(202);
    expect(out.body).toEqual({ deleted: false, pending: true });
    expect(mocks.beginAccountDeletion).toHaveBeenCalledWith('user-1');
    expect(mocks.deleteAccount).toHaveBeenCalledWith('user-1');
    expect(mocks.sendAccountDeletedEmail).not.toHaveBeenCalled();

    finishPurge();
    await flush();
    expect(mocks.sendAccountDeletedEmail).toHaveBeenCalledWith({ to: 'quelquun@example.test', name: 'Quelqu’un' });
  });

  it('le blocage échoue : erreur, et aucune purge ne démarre (la personne peut réessayer)', async () => {
    mocks.beginAccountDeletion.mockRejectedValue(Object.assign(new Error('appwrite down'), { code: 503 }));

    const out = await within(confirm());

    expect(out.status).toBeGreaterThanOrEqual(500);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('une purge de fond interrompue reprend plus tard, puis envoie l’accusé', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.deleteAccount
      .mockRejectedValueOnce(new Error('appwrite 500'))
      .mockResolvedValueOnce({});

    const out = await confirm();
    expect(out.status).toBe(202);
    await flush();
    expect(mocks.captureServerError).toHaveBeenCalledTimes(1);
    expect(mocks.sendAccountDeletedEmail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(2);
    expect(mocks.sendAccountDeletedEmail).toHaveBeenCalledTimes(1);
  });
});

describe('resumePendingAccountDeletions (A14-1, purge coupée par un redéploiement)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.deleteAccount.mockReset().mockResolvedValue({});
    mocks.sendAccountDeletedEmail.mockClear();
    mocks.listStalePendingDeletions.mockReset();
    mocks.users.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reprend chaque suppression en attente depuis plus de 15 min et envoie l’accusé', async () => {
    mocks.users.set('u-blocked', { $id: 'u-blocked', name: 'Bloqué', email: 'bloque@example.test' });
    mocks.listStalePendingDeletions.mockResolvedValue(['u-blocked', 'u-gone']);

    await expect(resumePendingAccountDeletions(1_000_000)).resolves.toEqual(['u-blocked', 'u-gone']);
    await flush();

    expect(mocks.listStalePendingDeletions).toHaveBeenCalledWith(1_000_000, 15 * 60_000);
    expect(mocks.deleteAccount.mock.calls.map(([userId]) => userId)).toEqual(['u-blocked', 'u-gone']);
    // Compte déjà effacé : registre complété, pas d'adresse, pas d'accusé.
    expect(mocks.sendAccountDeletedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendAccountDeletedEmail).toHaveBeenCalledWith({ to: 'bloque@example.test', name: 'Bloqué' });
  });

  it('ne double pas une purge encore en cours dans ce processus', async () => {
    let finish!: () => void;
    mocks.deleteAccount.mockReturnValueOnce(new Promise((resolve) => { finish = () => resolve({}); }));
    await confirm(); // purge de fond de user-1, en cours
    mocks.listStalePendingDeletions.mockResolvedValue(['user-1']);
    await expect(resumePendingAccountDeletions()).resolves.toEqual([]);
    expect(mocks.deleteAccount).toHaveBeenCalledTimes(1);
    finish();
    await flush();
  });
});
