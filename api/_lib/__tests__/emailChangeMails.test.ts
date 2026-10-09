import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendEmailChangeCodeEmail, sendEmailChangedNoticeEmail } from '../mailer';

/**
 * E-mails du changement d'adresse : le code part à une adresse pas encore
 * vérifiée, donc sans rien de saisi librement ; l'avis à l'ancienne adresse
 * cite le contact de RedView (l'expéditeur est noreply).
 */

const sent: Array<{ to: string[]; subject: string; text: string; html: string }> = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('SUPPORT_EMAIL', '');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('e-mails du changement d’adresse', () => {
  it('code envoyé à la nouvelle adresse : le code, rien d’autre de personnel', async () => {
    expect(await sendEmailChangeCodeEmail({ to: 'new@example.test', code: '123456' })).toEqual({ sent: true });
    const [mail] = sent;
    expect(mail!.to).toEqual(['new@example.test']);
    expect(mail!.subject).toContain('123456');
    expect(mail!.text).toMatch(/^Bonjour,\n/);
  });

  it('avis à l’ancienne adresse : nouvelle adresse masquée, contact de RedView cité', async () => {
    await sendEmailChangedNoticeEmail({ to: 'old@example.test', name: 'Ada', newEmail: 'nouvelle@example.test' });
    const [mail] = sent;
    expect(mail!.to).toEqual(['old@example.test']);
    expect(mail!.text).toContain('n*****@example.test');
    expect(mail!.text).not.toContain('nouvelle@example.test');
    expect(mail!.text).toContain('redview.app@proton.me');
    expect(mail!.html).toContain('redview.app@proton.me');
  });

  it('SUPPORT_EMAIL remplace l’adresse par défaut', async () => {
    vi.stubEnv('SUPPORT_EMAIL', 'aide@example.test');
    await sendEmailChangedNoticeEmail({ to: 'old@example.test', newEmail: 'n@example.test' });
    expect(sent[0]!.text).toContain('aide@example.test');
    expect(sent[0]!.text).not.toContain('redview.app@proton.me');
  });
});
