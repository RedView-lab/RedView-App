import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendAccountDeletedEmail,
  sendAccountDeletionCodeEmail,
  sendAccountExistsEmail,
  sendEmailChangeCodeEmail,
  sendEmailChangedNoticeEmail,
  sendRenewalReminderEmail,
  sendSubscriptionCanceledEmail,
  sendTrialEndingEmail,
  sendVerificationEmail,
} from '../mailer';

/**
 * Charte commune des e-mails (gabarit `emailLayout`) : chaque e-mail porte le
 * logo et le pied de page de RedView, garde une version texte, et n'injecte
 * jamais une valeur sans l'échapper.
 */

const sent: Array<{ to: string[]; subject: string; text: string; html: string }> = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('APP_BASE_URL', 'https://app.example.test/');
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

const HOSTILE = '<img src=x onerror=alert(1)> & "Ada"';
const subscription = { to: 'a@example.test', name: HOSTILE, planLabel: '1 an <b>', manageUrl: 'https://billing.example.test/?a=1&b="2"' };

async function sendAll() {
  await sendVerificationEmail({ to: 'a@example.test', code: '482913' });
  await sendAccountExistsEmail({ to: 'a@example.test' });
  await sendAccountDeletionCodeEmail({ to: 'a@example.test', code: '105732', name: HOSTILE });
  await sendEmailChangeCodeEmail({ to: 'a@example.test', code: '220011' });
  await sendEmailChangedNoticeEmail({ to: 'a@example.test', name: HOSTILE, newEmail: 'new@example.test' });
  await sendAccountDeletedEmail({ to: 'a@example.test', name: HOSTILE });
  await sendSubscriptionCanceledEmail({ ...subscription, endDate: '1 mai 2027' });
  await sendTrialEndingEmail({ ...subscription, amount: '14,90 €', chargeDate: '16 octobre 2026' });
  await sendRenewalReminderEmail({ ...subscription, amount: '119 €', renewalDate: '1 mai 2027' });
}

describe('charte des e-mails', () => {
  it('every e-mail has the RedView header, footer links and a text version', async () => {
    await sendAll();
    expect(sent).toHaveLength(9);
    for (const mail of sent) {
      expect(mail.html).toContain('src="https://app.example.test/brand/redview-email-logo.png"');
      expect(mail.html).toContain('src="https://app.example.test/brand/redview-email-logo-white.png"');
      expect(mail.html).toContain('alt="RedView"');
      expect(mail.html).toContain('href="https://app.example.test/mentions-legales"');
      expect(mail.html).toContain('href="https://app.example.test/confidentialite"');
      expect(mail.html).toContain('href="mailto:redview.app@proton.me"');
      expect(mail.text.trim().length).toBeGreaterThan(20);
      expect(mail.subject).toContain('RedView');
    }
  });

  it('shows one-time codes in the app’s code boxes, one digit per box', async () => {
    await sendVerificationEmail({ to: 'a@example.test', code: '482913' });
    const digits = [...sent[0]!.html.matchAll(/class="rv-digit"[^>]*>(\d)<\/div>/g)].map((match) => match[1]);
    expect(digits.join('')).toBe('482913');
  });

  it('escapes every interpolated value (names, plans, links)', async () => {
    await sendAll();
    for (const mail of sent) {
      expect(mail.html).not.toContain('<img src=x');
      expect(mail.html).not.toContain('<b>');
      expect(mail.html).not.toContain('b="2"');
    }
    expect(sent.some((mail) => mail.html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Ada&quot;'))).toBe(true);
    expect(sent.some((mail) => mail.html.includes('href="https://billing.example.test/?a=1&amp;b=&quot;2&quot;"'))).toBe(true);
  });

  it('keeps French non-breaking spaces before colons in the body', async () => {
    await sendVerificationEmail({ to: 'a@example.test', code: '482913' });
    expect(sent[0]!.html).toContain('terminer votre inscription&nbsp;:');
  });
});
