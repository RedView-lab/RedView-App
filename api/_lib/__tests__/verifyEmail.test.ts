import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

/**
 * Vérification de l'adresse d'un compte existant (api/auth/verify-email.ts) :
 * un compte créé directement par l'API d'Appwrite, sans code, prouve son
 * adresse avant d'entrer dans l'app (A15-2).
 */
const fakes = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return {
    storeDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rv-verify-email-')),
    session: { id: 'u1', email: 'squat@example.test' as string | null, emailVerified: false },
    users: { updateEmailVerification: vi.fn() },
    sent: [] as { to: string; code: string }[],
  };
});

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, default: { ...actual, tmpdir: () => fakes.storeDir }, tmpdir: () => fakes.storeDir };
});
vi.mock('../appwrite.js', () => ({
  getAppwriteUsers: () => fakes.users,
  requireAuthenticatedUser: async () => ({ ...fakes.session }),
}));
vi.mock('../../../server/lib/observability.mjs', () => ({ captureServerError: () => {} }));
vi.mock('../mailer.ts', () => ({
  sendVerificationEmail: vi.fn(async (message: { to: string; code: string }) => {
    fakes.sent.push(message);
    return { sent: true };
  }),
  sendAccountDeletionCodeEmail: vi.fn(async () => ({ sent: true })),
  sendEmailChangeCodeEmail: vi.fn(async () => ({ sent: true })),
}));

const { default: handler } = await import('../../auth/verify-email');

async function call(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const out = { status: 200, body: undefined as Record<string, unknown> | undefined };
  const res = {
    status(code: number) { out.status = code; return res; },
    setHeader() { return res; },
    json(data: Record<string, unknown>) { out.body = data; return res; },
  } as unknown as ApiResponse;
  await handler({ method: 'POST', query: {}, headers: { authorization: 'Bearer jwt' }, body } as unknown as ApiRequest, res);
  return out;
}

let counter = 0;
beforeEach(() => {
  counter += 1;
  fakes.session.id = `u${counter}`;
  fakes.session.emailVerified = false;
  fakes.users.updateEmailVerification.mockReset().mockResolvedValue({});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('api/auth/verify-email (A15-2)', () => {
  it('code envoyé à l’adresse du compte, puis l’adresse est marquée vérifiée', async () => {
    expect(await call({ action: 'request-code' })).toEqual({ status: 200, body: { sent: true } });
    const { to, code } = fakes.sent.at(-1)!;
    expect(to).toBe('squat@example.test');
    expect(await call({ action: 'confirm', code })).toEqual({ status: 200, body: { verified: true } });
    expect(fakes.users.updateEmailVerification).toHaveBeenCalledWith(fakes.session.id, true);
    // Usage unique.
    expect((await call({ action: 'confirm', code })).status).toBe(400);
  });

  it('mauvais code : refusé, rien n’est marqué', async () => {
    await call({ action: 'request-code' });
    const code = fakes.sent.at(-1)!.code;
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await call({ action: 'confirm', code: wrong })).status).toBe(400);
    expect(fakes.users.updateEmailVerification).not.toHaveBeenCalled();
  });

  it('adresse déjà vérifiée : rien à faire, aucun e-mail', async () => {
    fakes.session.emailVerified = true;
    const sentBefore = fakes.sent.length;
    expect(await call({ action: 'request-code' })).toEqual({ status: 200, body: { verified: true } });
    expect(fakes.sent.length).toBe(sentBefore);
  });

  it('marquage impossible (Appwrite en panne) : 503 et le code reste valable', async () => {
    await call({ action: 'request-code' });
    const code = fakes.sent.at(-1)!.code;
    fakes.users.updateEmailVerification.mockRejectedValueOnce(new Error('down'));
    expect((await call({ action: 'confirm', code })).status).toBe(503);
    expect((await call({ action: 'confirm', code })).status).toBe(200);
  });
});
