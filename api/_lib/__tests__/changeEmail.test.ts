import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

/**
 * Changement d'e-mail (api/auth/change-email.ts) : code envoyé à la nouvelle
 * adresse et valable pour elle seule, mot de passe vérifié par Appwrite avec
 * la session de l'utilisateur, mauvais mot de passe compté comme un échec,
 * adresse gardée vérifiée, client Stripe suivi, ancienne adresse prévenue.
 */

// Le magasin de codes écrit dans os.tmpdir() : un dossier à part.
const fakes = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return {
    storeDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rv-change-email-')),
    session: { id: 'u1', email: 'old@example.test' as string | null },
    profile: { $id: 'u1', name: 'Ada', passwordUpdate: '2026-01-01T00:00:00.000Z' as string },
    takenEmails: new Set<string>(),
    users: { get: vi.fn(), list: vi.fn(), updateEmailVerification: vi.fn() },
    updateEmail: vi.fn<(email: string, password: string) => Promise<unknown>>(),
    jwtUsed: [] as string[],
    customer: null as { stripe_customer_id: string | null; billing_email_mode: string | null } | null,
    stripeUpdate: vi.fn(),
    sentCodes: [] as { to: string; code: string }[],
    mailDown: false,
    notices: [] as { to: string; newEmail: string }[],
    takenNotices: [] as string[],
    captured: [] as unknown[],
  };
});

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, default: { ...actual, tmpdir: () => fakes.storeDir }, tmpdir: () => fakes.storeDir };
});
vi.mock('node-appwrite', () => {
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
    setJWT(jwt: string) { fakes.jwtUsed.push(jwt); return this; }
  }
  class Account {
    updateEmail(email: string, password: string) { return fakes.updateEmail(email, password); }
  }
  return { Client, Account, Query: { equal: (field: string, value: string) => ({ field, value }), limit: () => ({}) } };
});
vi.mock('../appwrite.js', () => ({
  getAppwriteEndpoint: () => 'http://appwrite.test/v1',
  getAppwriteProjectId: () => 'test',
  getAppwriteUsers: () => fakes.users,
  requireAuthenticatedUser: async () => ({ ...fakes.session }),
}));
vi.mock('../billing/customers.js', () => ({ getCustomerRow: async () => fakes.customer }));
vi.mock('../stripe.js', () => ({ getStripeServer: () => ({ customers: { update: fakes.stripeUpdate } }) }));
vi.mock('../../../server/lib/observability.mjs', () => ({ captureServerError: (error: unknown) => { fakes.captured.push(error); } }));
// Un seul module (importé en .ts par verificationStore, en .js par la route).
vi.mock('../mailer.ts', () => ({
  sendEmailChangeCodeEmail: vi.fn(async (message: { to: string; code: string }) => {
    if (fakes.mailDown) return { sent: false };
    fakes.sentCodes.push(message);
    return { sent: true };
  }),
  sendEmailChangedNoticeEmail: vi.fn(async (message: { to: string; newEmail: string }) => {
    fakes.notices.push(message);
    return { sent: true };
  }),
  sendEmailChangeTakenEmail: vi.fn(async (message: { to: string }) => {
    fakes.takenNotices.push(message.to);
    return { sent: true };
  }),
  sendVerificationEmail: vi.fn(async () => ({ sent: true })),
  sendAccountDeletionCodeEmail: vi.fn(async () => ({ sent: true })),
}));

const { default: handler } = await import('../../auth/change-email');

interface Captured {
  status: number;
  body: { error?: string; sent?: boolean; email?: string } | undefined;
}

async function call(body: Record<string, unknown>): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader() { return res; },
    json(data: Captured['body']) { captured.body = data; return res; },
  } as unknown as ApiResponse;
  const req = { method: 'POST', query: {}, headers: { authorization: 'Bearer user-jwt' }, body } as unknown as ApiRequest;
  await handler(req, res);
  return captured;
}

let counter = 0;
/** Compte neuf (quotas par compte) et un code demandé pour `newEmail`. */
async function requestCode(newEmail = 'new@example.test'): Promise<string> {
  counter += 1;
  fakes.session.id = `u${counter}`;
  const response = await call({ action: 'request-code', newEmail });
  expect(response.status).toBe(200);
  return fakes.sentCodes.at(-1)!.code;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fakes.session.email = 'old@example.test';
  fakes.profile.passwordUpdate = '2026-01-01T00:00:00.000Z';
  fakes.takenEmails.clear();
  fakes.users.get.mockReset().mockImplementation(async () => ({ ...fakes.profile }));
  fakes.users.list.mockReset().mockImplementation(async ([query]: [{ value: string }]) => ({ total: fakes.takenEmails.has(query.value) ? 1 : 0 }));
  fakes.users.updateEmailVerification.mockReset().mockResolvedValue({});
  fakes.updateEmail.mockReset().mockResolvedValue({});
  fakes.customer = null;
  fakes.stripeUpdate.mockReset().mockResolvedValue({});
  fakes.notices.length = 0;
  fakes.takenNotices.length = 0;
  fakes.captured.length = 0;
  fakes.mailDown = false;
});

describe('api/auth/change-email', () => {
  it('parcours complet : code à la nouvelle adresse, mot de passe vérifié par Appwrite, adresse gardée vérifiée, Stripe et ancienne adresse prévenus', async () => {
    fakes.customer = { stripe_customer_id: 'cus_1', billing_email_mode: null };
    const code = await requestCode('New@Example.test ');
    expect(fakes.sentCodes.at(-1)!.to).toBe('new@example.test');

    const done = await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' });
    expect(done).toEqual({ status: 200, body: { email: 'new@example.test' } });
    expect(fakes.updateEmail).toHaveBeenCalledWith('new@example.test', 'ancien-mdp');
    expect(fakes.jwtUsed.at(-1)).toBe('user-jwt');
    expect(fakes.users.updateEmailVerification).toHaveBeenCalledWith(fakes.session.id, true);
    expect(fakes.stripeUpdate).toHaveBeenCalledWith('cus_1', { email: 'new@example.test' });
    expect(fakes.notices).toEqual([{ to: 'old@example.test', name: 'Ada', newEmail: 'new@example.test' }]);

    // usage unique
    const reused = await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' });
    expect(reused.status).toBe(400);
  });

  it('un code ne vaut que pour l’adresse à laquelle il a été envoyé', async () => {
    const code = await requestCode('new@example.test');
    const other = await call({ action: 'confirm', newEmail: 'attacker@example.test', code, password: 'ancien-mdp' });
    expect(other.status).toBe(400);
    expect(other.body?.error).toMatch(/autre adresse/);
    expect(fakes.updateEmail).not.toHaveBeenCalled();
  });

  it('mauvais mot de passe : refus clair, code gardé, échec compté (verrou après 10)', async () => {
    const code = await requestCode();
    fakes.updateEmail.mockRejectedValue(Object.assign(new Error('Invalid credentials'), { code: 401, type: 'user_invalid_credentials' }));
    const wrong = await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'mauvais-mdp' });
    expect(wrong).toEqual({ status: 400, body: { error: 'Mot de passe actuel incorrect.' } });
    expect(fakes.users.updateEmailVerification).not.toHaveBeenCalled();

    for (let i = 0; i < 8; i += 1) {
      await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'mauvais-mdp' });
    }
    // dixième échec : le compte est verrouillé, même avec le bon mot de passe
    await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'mauvais-mdp' });
    fakes.updateEmail.mockResolvedValue({});
    const locked = await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' });
    expect(locked.status).toBe(429);
  });

  it('adresse prise : aucun code (propriétaire prévenu), ou refus à la confirmation si elle l’a été entre-temps (code gardé)', async () => {
    counter += 1;
    fakes.session.id = `u${counter}`;
    fakes.takenEmails.add('taken@example.test');
    const sentBefore = fakes.sentCodes.length;
    const early = await call({ action: 'request-code', newEmail: 'taken@example.test' });
    // Même réponse qu'un envoi de code : pas de sonde d'existence de compte (A1-3).
    expect(early).toEqual({ status: 200, body: { sent: true } });
    expect(fakes.sentCodes.length).toBe(sentBefore);
    expect(fakes.takenNotices).toEqual(['taken@example.test']);

    const code = await requestCode('late@example.test');
    fakes.updateEmail.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 409, type: 'user_email_already_exists' }));
    const late = await call({ action: 'confirm', newEmail: 'late@example.test', code, password: 'ancien-mdp' });
    expect(late.status).toBe(409);
    const retried = await call({ action: 'confirm', newEmail: 'late@example.test', code, password: 'ancien-mdp' });
    expect(retried.status).toBe(200);
  });

  it('e-mail du code non parti : 503, et le nouvel essai part tout de suite (demande non décomptée)', async () => {
    counter += 1;
    fakes.session.id = `u${counter}`;
    fakes.mailDown = true;
    const down = await call({ action: 'request-code', newEmail: 'new@example.test' });
    expect(down.status).toBe(503);
    fakes.mailDown = false;
    const retried = await call({ action: 'request-code', newEmail: 'new@example.test' });
    expect(retried).toEqual({ status: 200, body: { sent: true } });
  });

  it('compte sans mot de passe (Google) : il en définit un d’abord', async () => {
    fakes.profile.passwordUpdate = '';
    const response = await call({ action: 'request-code', newEmail: 'new@example.test' });
    expect(response.status).toBe(400);
    expect(response.body?.error).toMatch(/^Définissez d’abord un mot de passe/);
  });

  it('adresse invalide ou identique : refusée sans envoyer de code', async () => {
    const sentBefore = fakes.sentCodes.length;
    expect((await call({ action: 'request-code', newEmail: 'pas-une-adresse' })).status).toBe(400);
    expect((await call({ action: 'request-code', newEmail: 'OLD@example.test' })).body?.error).toBe('C’est déjà l’adresse de votre compte.');
    expect(fakes.sentCodes.length).toBe(sentBefore);
  });

  it('adresse de facturation choisie à part : Stripe n’est pas touché ; une panne Stripe ne fait pas échouer', async () => {
    fakes.customer = { stripe_customer_id: 'cus_2', billing_email_mode: 'alternative' };
    let code = await requestCode();
    expect((await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' })).status).toBe(200);
    expect(fakes.stripeUpdate).not.toHaveBeenCalled();

    fakes.customer = { stripe_customer_id: 'cus_3', billing_email_mode: null };
    fakes.stripeUpdate.mockRejectedValueOnce(new Error('stripe down'));
    code = await requestCode();
    expect((await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' })).status).toBe(200);
  });
  it('adresse changée mais marquage « vérifiée » en échec : succès quand même, Stripe et ancienne adresse prévenus, échec signalé (A1-2)', async () => {
    fakes.customer = { stripe_customer_id: 'cus_4', billing_email_mode: null };
    const code = await requestCode();
    fakes.users.updateEmailVerification.mockRejectedValue(new Error('appwrite 503'));
    const done = await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' });
    expect(done).toEqual({ status: 200, body: { email: 'new@example.test' } });
    expect(fakes.users.updateEmailVerification).toHaveBeenCalledTimes(2);
    expect(fakes.stripeUpdate).toHaveBeenCalledWith('cus_4', { email: 'new@example.test' });
    expect(fakes.notices).toHaveLength(1);
    expect(fakes.captured.map(String)).toEqual(['Error: appwrite 503']);
  });

  it('marquage « vérifiée » raté une fois : le second essai suffit, rien n’est signalé', async () => {
    const code = await requestCode();
    fakes.users.updateEmailVerification.mockRejectedValueOnce(new Error('blip'));
    const done = await call({ action: 'confirm', newEmail: 'new@example.test', code, password: 'ancien-mdp' });
    expect(done.status).toBe(200);
    expect(fakes.captured).toEqual([]);
  });
});
