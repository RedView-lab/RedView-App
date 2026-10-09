import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiRequest, ApiResponse } from '../types';

// Le magasin de codes écrit dans os.tmpdir() : un dossier à part, pas celui du serveur de dev.
const { storeDir, users } = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return {
    storeDir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rv-send-code-')),
    users: { list: vi.fn() },
  };
});

vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>();
  return { ...actual, default: { ...actual, tmpdir: () => storeDir }, tmpdir: () => storeDir };
});
vi.mock('../appwrite.js', () => ({ getAppwriteUsers: () => users }));

const { default: handler } = await import('../../auth/send-verification-code');

/** Texte libre qu'un tiers glisserait dans un e-mail officiel adressé à sa cible. */
const INJECTED_NAME = 'Votre compte est suspendu, appelez le 01 23 45 67 89';

interface SentEmail {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

let sent: SentEmail[] = [];

async function requestCode(email: string, name: string): Promise<number> {
  let status = 200;
  const res = {
    status(code: number) { status = code; return res; },
    json() { return res; },
  } as unknown as ApiResponse;
  await handler({ method: 'POST', body: { email, name } } as unknown as ApiRequest, res);
  return status;
}

describe('send-verification-code', () => {
  beforeEach(() => {
    sent = [];
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentEmail);
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never puts the name typed by the requester into the signup code email', async () => {
    users.list.mockResolvedValue({ total: 0, users: [] });
    expect(await requestCode('new-user@example.com', INJECTED_NAME)).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['new-user@example.com']);
    expect(sent[0].html).not.toContain('suspendu');
    expect(sent[0].text).not.toContain('suspendu');
    expect(sent[0].html).toContain('Bonjour,');
  });

  it('never puts the name typed by the requester into the "account exists" email', async () => {
    users.list.mockResolvedValue({ total: 1, users: [{ $id: 'u1' }] });
    expect(await requestCode('existing@example.com', INJECTED_NAME)).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Vous avez déjà un compte RedView');
    expect(sent[0].html).not.toContain('suspendu');
    expect(sent[0].text).not.toContain('suspendu');
    expect(sent[0].text.startsWith('Bonjour,')).toBe(true);
  });

  it.each([
    ['no account', 0],
    ['existing account', 1],
  ])('answers 503 when the e-mail could not be sent (%s), and lets the person retry at once', async (_label, total) => {
    users.list.mockResolvedValue({ total, users: [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Resend down' }), { status: 500 })));
    const email = `resend-down-${total}@example.com`;
    expect(await requestCode(email, 'Nom')).toBe(503);
    // Sans remboursement de la demande, le second essai tomberait sur le délai de 30 s (429).
    expect(await requestCode(email, 'Nom')).toBe(503);
  });
});
