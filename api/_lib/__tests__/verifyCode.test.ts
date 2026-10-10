import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

// Le magasin de codes écrit dans os.tmpdir() : un dossier à part, pas celui du serveur de dev.
const { storeDir, users, sentCodes } = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return {
    storeDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rv-verify-code-')),
    users: { create: vi.fn(), updateEmailVerification: vi.fn() },
    sentCodes: [] as string[],
  };
});

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, default: { ...actual, tmpdir: () => storeDir }, tmpdir: () => storeDir };
});
vi.mock('../appwrite.js', () => ({ getAppwriteUsers: () => users }));
vi.mock('../mailer.ts', () => ({
  sendVerificationEmail: vi.fn(async ({ code }: { code: string }) => {
    sentCodes.push(code);
    return { sent: true };
  }),
  sendAccountDeletionCodeEmail: vi.fn(async () => ({ sent: true })),
}));

const { default: handler } = await import('../../auth/verify-code');
const { requestVerificationCode } = await import('../verificationStore');

interface Captured {
  status: number;
  body: { error?: string; success?: boolean } | undefined;
}

async function verify(email: string, code: string, password = 'correct horse battery', ip = '198.51.100.1'): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return res; },
    setHeader() { return res; },
    json(data: Captured['body']) { captured.body = data; return res; },
  } as unknown as ApiResponse;
  const req = { method: 'POST', query: {}, headers: {}, socket: { remoteAddress: ip }, body: { email, code, password, name: 'Alex' } } as unknown as ApiRequest;
  await handler(req, res);
  return captured;
}

let counter = 0;
async function issueCode(): Promise<{ email: string; code: string }> {
  counter += 1;
  const email = `rider${counter}@example.test`;
  await requestVerificationCode(email);
  return { email, code: sentCodes.at(-1) ?? '' };
}

describe('api/auth/verify-code', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    users.create.mockReset();
    users.updateEmailVerification.mockReset();
    users.create.mockImplementation(async (id: string, email: string, _phone: unknown, _password: string, name: string) => ({ $id: id, email, name }));
    users.updateEmailVerification.mockResolvedValue({});
  });

  it('crée le compte puis consomme le code', async () => {
    const { email, code } = await issueCode();
    const ok = await verify(email, code);
    expect(ok.status).toBe(200);
    expect(users.updateEmailVerification).toHaveBeenCalledTimes(1);
    const reused = await verify(email, code);
    expect(reused.status).toBe(400);
    expect(reused.body?.error).toBe('Aucun code trouvé pour cet e-mail. Veuillez en demander un nouveau.');
  });

  it('garde le code valable quand Appwrite échoue : un nouvel essai réussit', async () => {
    const { email, code } = await issueCode();
    users.create.mockRejectedValueOnce(Object.assign(new Error('Server Error'), { code: 503 }));
    const failed = await verify(email, code);
    expect(failed.status).toBe(500);
    const retried = await verify(email, code);
    expect(retried.status).toBe(200);
    expect(users.create).toHaveBeenCalledTimes(2);
  });

  it('explique un mot de passe refusé par Appwrite, sans consommer le code', async () => {
    const { email, code } = await issueCode();
    users.create.mockRejectedValueOnce(Object.assign(
      new Error('Invalid `password` param: Password must be between 8 and 265 characters long, and should not be one of the commonly used password.'),
      { code: 400, type: 'general_argument_invalid' },
    ));
    const refused = await verify(email, code, 'password123');
    expect(refused.status).toBe(400);
    expect(refused.body?.error).toMatch(/^Ce mot de passe est refusé/);
    expect((await verify(email, code)).status).toBe(200);
  });

  it('consomme le code quand le compte existe déjà', async () => {
    const { email, code } = await issueCode();
    users.create.mockRejectedValueOnce(Object.assign(new Error('A user with the same id, email, or phone already exists in this project.'), { code: 409 }));
    expect((await verify(email, code)).status).toBe(409);
    expect((await verify(email, code)).status).toBe(400);
  });

  it('ne signale pas d’échec quand seul le drapeau « e-mail vérifié » n’a pas pu être posé', async () => {
    const { email, code } = await issueCode();
    users.updateEmailVerification.mockRejectedValueOnce(new Error('timeout'));
    const out = await verify(email, code);
    expect(out.status).toBe(200);
    expect(out.body?.success).toBe(true);
  });

  it('un tiers qui tape de mauvais codes ne bloque pas l’inscription du vrai titulaire depuis une autre IP (A1-4)', async () => {
    const { email } = await issueCode();
    const wrong = (code: string) => (code === '000000' ? '111111' : '000000');
    // 10 échecs depuis l'IP de l'attaquant (deux codes de 5 essais) : son couple adresse + IP est verrouillé.
    let last: Captured | null = null;
    for (let round = 0; round < 2; round += 1) {
      await requestVerificationCode(email);
      const code = sentCodes.at(-1)!;
      for (let attempt = 0; attempt < 5; attempt += 1) last = await verify(email, wrong(code), undefined, '203.0.113.66');
    }
    expect(last?.status).toBe(429);
    // Le titulaire, depuis chez lui : un nouveau code passe.
    await requestVerificationCode(email);
    const ok = await verify(email, sentCodes.at(-1)!, undefined, '198.51.100.7');
    expect(ok.status).toBe(200);
    expect(users.create).toHaveBeenCalledTimes(1);
  });

  it('le verrou d’un couple adresse + IP n’invalide pas le code en attente du titulaire (A1-4)', async () => {
    const { email } = await issueCode();
    const code = sentCodes.at(-1)!;
    const wrong = code === '000000' ? '111111' : '000000';
    // Un tiers change d'IP à chaque essai : chaque couple reste sous son verrou.
    for (let attempt = 0; attempt < 4; attempt += 1) await verify(email, wrong, undefined, `203.0.113.${attempt + 1}`);
    const ok = await verify(email, code, undefined, '198.51.100.7');
    expect(ok.status).toBe(200);
  });
});
