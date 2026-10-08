/** Corps JSON renvoyé par l'API Resend (succès : id ; échec : message). */
type ResendResult = { id?: string; message?: string };

interface SendVerificationEmailOptions {
  to: string;
  code: string;
  name?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const RESEND_FALLBACK_SENDER = 'RedView <onboarding@resend.dev>';
const RESEND_TIMEOUT_MS = 10_000;

function maskEmail(email: string): string {
  return email.replace(/^(.)(.*)(@.*)$/, (_, first, middle, domain) => `${first}${'*'.repeat(Math.min(middle.length, 5))}${domain}`);
}

/**
 * Envoi Resend. Si l'expéditeur configuré est refusé (domaine pas encore
 * vérifié), un second essai part de l'adresse de test de Resend. Chaque appel
 * est borné : un Resend qui ne répond pas ne bloque pas la requête jusqu'au
 * timeout du serveur.
 */
async function sendTransactionalEmail(tag: string, message: { to: string; subject: string; text: string; html: string }): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'RedView <noreply@redview.tech>';
  console.log(`[${tag}] 📧 Dispatching email to ${maskEmail(message.to)}`);
  if (!apiKey) {
    console.warn(`[${tag}] RESEND_API_KEY is not configured.`);
    return { sent: false };
  }
  const send = (sender: string) =>
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  try {
    let response = await send(from);
    let data = (await response.json().catch(() => ({}))) as ResendResult;
    if (!response.ok && from !== RESEND_FALLBACK_SENDER) {
      console.warn(`[${tag}] Resend sending from ${from} returned ${response.status} (${data?.message}). Testing fallback…`);
      const fallback = await send(RESEND_FALLBACK_SENDER);
      if (fallback.ok) {
        response = fallback;
        data = (await fallback.json().catch(() => ({}))) as ResendResult;
      }
    }
    if (!response.ok) {
      console.warn(`[${tag}] Resend API response error:`, data);
      return { sent: false };
    }
    console.log(`[${tag}] ✅ Email sent via Resend, id:`, data?.id);
    return { sent: true };
  } catch (err) {
    console.error(`[${tag}] Failed to send email via Resend:`, err);
    return { sent: false };
  }
}

export async function sendVerificationEmail({
  to,
  code,
  name,
}: SendVerificationEmailOptions): Promise<{ sent: boolean }> {
  const digits = (code || '').split('');
  const cleanName = name && name.trim().length > 0 && !name.includes('@') ? escapeHtml(name.trim()) : '';
  const greeting = cleanName ? `Bonjour ${cleanName},` : 'Bonjour,';

  const html = `
<!DOCTYPE html>
<html lang="fr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${code} est votre code de vérification RedView</title>
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }
    body {
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    @media (prefers-color-scheme: dark) {
      .body-bg { background-color: #0b0c10 !important; }
      .email-card { background-color: #12141c !important; border-color: #232736 !important; }
      .text-title { color: #ffffff !important; }
      .text-body { color: #94a3b8 !important; }
      .text-brand { color: #ffffff !important; }
      .digit-box { background-color: #181b26 !important; border-color: #2e3448 !important; color: #ffffff !important; }
      .text-muted { color: #64748b !important; }
      .divider { border-color: #1e2230 !important; }
    }
    @media only screen and (max-width: 480px) {
      .email-card { padding: 28px 20px !important; }
      .digit-box { width: 36px !important; height: 46px !important; line-height: 46px !important; font-size: 22px !important; }
    }
  </style>
</head>
<body class="body-bg" style="margin: 0; padding: 0; background-color: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  
  <!-- Preheader invisible pour aperçu net dans l'inbox -->
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    ${code} est votre code de sécurité RedView. Valable 10 minutes.
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>

  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="body-bg" style="background-color: #f4f5f7; width: 100%; min-height: 100vh; padding: 40px 16px;">
    <tr>
      <td align="center" valign="top">

        <!-- Carte principale -->
        <table role="presentation" class="email-card" border="0" cellspacing="0" cellpadding="0" style="max-width: 440px; width: 100%; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04); overflow: hidden;">
          <tr>
            <td style="padding: 40px 36px; text-align: center;">

              <!-- Header Brand (Indicateur rouge signature + typo épurée) -->
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin: 0 auto 28px;">
                <tr>
                  <td style="vertical-align: middle; padding-right: 8px;">
                    <table role="presentation" border="0" cellspacing="0" cellpadding="0">
                      <tr>
                        <td style="width: 9px; height: 9px; background-color: #e11d48; border-radius: 50%; line-height: 1px; font-size: 1px;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                  <td style="vertical-align: middle;">
                    <span class="text-brand" style="font-size: 15px; font-weight: 800; letter-spacing: 2px; color: #0f172a; text-transform: uppercase;">REDVIEW</span>
                  </td>
                </tr>
              </table>

              <!-- Titre sobre & humain -->
              <h1 class="text-title" style="margin: 0 0 10px; font-size: 21px; font-weight: 600; color: #0f172a; letter-spacing: -0.02em; line-height: 28px;">
                Code de vérification
              </h1>

              <p class="text-body" style="margin: 0 0 32px; font-size: 14px; line-height: 22px; color: #475569;">
                ${greeting}<br>
                Voici votre code de sécurité pour valider votre adresse e-mail :
              </p>

              <!-- Cases de code individuelles (Option C) -->
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin: 0 auto 28px;">
                <tr>
                  ${digits.map(d => `
                    <td style="padding: 0 4px;">
                      <div class="digit-box" style="width: 44px; height: 56px; line-height: 56px; background-color: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 12px; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 26px; font-weight: 700; color: #0f172a; text-align: center; display: block;">
                        ${d}
                      </div>
                    </td>
                  `).join('')}
                </tr>
              </table>

              <p class="text-muted" style="margin: 0 0 28px; font-size: 13px; line-height: 20px; color: #64748b;">
                Ce code expire dans <strong style="font-weight: 600;">10 minutes</strong>.
              </p>

              <!-- Ligne de séparation très fine -->
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                <tr>
                  <td class="divider" style="border-top: 1px solid #f1f5f9; height: 1px; line-height: 1px; font-size: 1px;">&nbsp;</td>
                </tr>
              </table>

              <!-- Footer sécuritaire & minimal -->
              <p class="text-muted" style="margin: 0 0 12px; font-size: 12px; line-height: 18px; color: #94a3b8;">
                Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.
              </p>

              <p class="text-muted" style="margin: 0; font-size: 11px; line-height: 16px; color: #cbd5e1;">
                © RedView · Plateforme de cartographie 3D Haute Définition
              </p>

            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();

  return sendTransactionalEmail('AUTH', {
    to,
    subject: `${code} est votre code de vérification RedView`,
    text: `Votre code de vérification RedView est : ${code}. Il expire dans 10 minutes.`,
    html,
  });
}

interface SendAccountExistsEmailOptions {
  to: string;
  name?: string;
}

/**
 * Envoyé à la place du code quand une inscription est demandée pour une
 * adresse déjà associée à un compte : l'API répond exactement comme pour un
 * envoi de code (anti-énumération), seul le propriétaire de la boîte voit
 * la différence.
 */
export async function sendAccountExistsEmail({
  to,
  name,
}: SendAccountExistsEmailOptions): Promise<{ sent: boolean }> {
  const appUrl = (process.env.APP_BASE_URL?.trim() || 'https://app.redview.tech').replace(/\/+$/, '');
  const safeAppUrl = escapeHtml(`${appUrl}/`);

  const cleanName = name && name.trim().length > 0 && !name.includes('@') ? escapeHtml(name.trim()) : '';
  const greeting = cleanName ? `Bonjour ${cleanName},` : 'Bonjour,';
  const subject = 'Vous avez déjà un compte RedView';
  const text =
    `${cleanName ? `Bonjour ${name?.trim()},` : 'Bonjour,'}\n\n` +
    'Une inscription a été demandée avec cette adresse e-mail, mais un compte RedView existe déjà.\n' +
    `Connectez-vous sur ${appUrl}/ ou, si vous avez oublié votre mot de passe, utilisez « Mot de passe oublié ».\n\n` +
    "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.\n\n" +
    '---\n' +
    'Someone tried to sign up with this e-mail address, but a RedView account already exists. ' +
    `Please log in at ${appUrl}/ or reset your password. If this wasn't you, you can safely ignore this e-mail.`;

  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(subject)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    @media (prefers-color-scheme: dark) {
      .body-bg { background-color: #0b0c10 !important; }
      .email-card { background-color: #12141c !important; border-color: #232736 !important; }
      .text-title { color: #ffffff !important; }
      .text-body { color: #94a3b8 !important; }
      .text-brand { color: #ffffff !important; }
      .text-muted { color: #64748b !important; }
      .divider { border-color: #1e2230 !important; }
    }
    @media only screen and (max-width: 480px) {
      .email-card { padding: 28px 20px !important; }
    }
  </style>
</head>
<body class="body-bg" style="margin: 0; padding: 0; background-color: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="body-bg" style="background-color: #f4f5f7; width: 100%; padding: 40px 16px;">
    <tr>
      <td align="center" valign="top">
        <table role="presentation" class="email-card" border="0" cellspacing="0" cellpadding="0" style="max-width: 440px; width: 100%; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04); overflow: hidden;">
          <tr>
            <td style="padding: 40px 36px; text-align: center;">
              <p class="text-brand" style="margin: 0 0 28px; font-size: 15px; font-weight: 800; letter-spacing: 2px; color: #0f172a; text-transform: uppercase;">
                <span style="color: #e11d48;">&#9679;</span> REDVIEW
              </p>
              <h1 class="text-title" style="margin: 0 0 10px; font-size: 21px; font-weight: 600; color: #0f172a; letter-spacing: -0.02em; line-height: 28px;">
                Vous avez déjà un compte
              </h1>
              <p class="text-body" style="margin: 0 0 24px; font-size: 14px; line-height: 22px; color: #475569;">
                ${greeting}<br>
                Une inscription a été demandée avec cette adresse e-mail, mais un compte RedView existe déjà.
                Connectez-vous, ou utilisez « Mot de passe oublié » si vous ne vous souvenez plus de votre mot de passe.
              </p>
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin: 0 auto 28px;">
                <tr>
                  <td style="border-radius: 10px; background-color: #e11d48;">
                    <a href="${safeAppUrl}" style="display: inline-block; padding: 12px 22px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none;">Se connecter à RedView</a>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                <tr>
                  <td class="divider" style="border-top: 1px solid #f1f5f9; height: 1px; line-height: 1px; font-size: 1px;">&nbsp;</td>
                </tr>
              </table>
              <p class="text-muted" style="margin: 0 0 12px; font-size: 12px; line-height: 18px; color: #94a3b8;">
                Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.
              </p>
              <p class="text-muted" style="margin: 0 0 12px; font-size: 12px; line-height: 18px; color: #94a3b8;">
                Someone tried to sign up with this e-mail address, but a RedView account already exists. Please log in or reset your password. If this wasn't you, you can safely ignore this e-mail.
              </p>
              <p class="text-muted" style="margin: 0; font-size: 11px; line-height: 16px; color: #cbd5e1;">
                © RedView · Plateforme de cartographie 3D Haute Définition
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return sendTransactionalEmail('AUTH', { to, subject, text, html });
}

// ─────────────────────── Suppression de compte ───────────────────────

/** Gabarit des e-mails de compte : même carte que le code de vérification. */
function accountEmailHtml({ title, preheader, bodyHtml }: { title: string; preheader: string; bodyHtml: string }): string {
  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    @media (prefers-color-scheme: dark) {
      .body-bg { background-color: #0b0c10 !important; }
      .email-card { background-color: #12141c !important; border-color: #232736 !important; }
      .text-title { color: #ffffff !important; }
      .text-body { color: #94a3b8 !important; }
      .text-brand { color: #ffffff !important; }
      .digit-box { background-color: #181b26 !important; border-color: #2e3448 !important; color: #ffffff !important; }
      .text-muted { color: #64748b !important; }
      .divider { border-color: #1e2230 !important; }
    }
    @media only screen and (max-width: 480px) {
      .email-card { padding: 28px 20px !important; }
      .digit-box { width: 36px !important; height: 46px !important; line-height: 46px !important; font-size: 22px !important; }
    }
  </style>
</head>
<body class="body-bg" style="margin: 0; padding: 0; background-color: #f4f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="body-bg" style="background-color: #f4f5f7; width: 100%; padding: 40px 16px;">
    <tr>
      <td align="center" valign="top">
        <table role="presentation" class="email-card" border="0" cellspacing="0" cellpadding="0" style="max-width: 440px; width: 100%; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04); overflow: hidden;">
          <tr>
            <td style="padding: 40px 36px; text-align: center;">
              <p class="text-brand" style="margin: 0 0 28px; font-size: 15px; font-weight: 800; letter-spacing: 2px; color: #0f172a; text-transform: uppercase;">
                <span style="color: #e11d48;">&#9679;</span> REDVIEW
              </p>
              <h1 class="text-title" style="margin: 0 0 10px; font-size: 21px; font-weight: 600; color: #0f172a; letter-spacing: -0.02em; line-height: 28px;">
                ${escapeHtml(title)}
              </h1>
              ${bodyHtml}
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                <tr>
                  <td class="divider" style="border-top: 1px solid #f1f5f9; height: 1px; line-height: 1px; font-size: 1px;">&nbsp;</td>
                </tr>
              </table>
              <p class="text-muted" style="margin: 0; font-size: 11px; line-height: 16px; color: #cbd5e1;">
                © RedView · Plateforme de cartographie 3D Haute Définition
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

function greetingFor(name?: string): string {
  const cleanName = name && name.trim().length > 0 && !name.includes('@') ? name.trim() : '';
  return cleanName ? `Bonjour ${cleanName},` : 'Bonjour,';
}

/** Code à 6 chiffres qui confirme la suppression définitive d'un compte (api/auth/delete-account.ts). */
export async function sendAccountDeletionCodeEmail({ to, code, name }: { to: string; code: string; name?: string }): Promise<{ sent: boolean }> {
  const greeting = greetingFor(name);
  const subject = `${code} : code de suppression de votre compte RedView`;
  const text =
    `${greeting}\n\n` +
    `Votre code pour supprimer définitivement votre compte RedView est : ${code}. Il expire dans 10 minutes.\n\n` +
    'La suppression efface vos projets, fichiers FIT, dossiers, partages et votre abonnement. Elle est irréversible.\n' +
    "Si vous n'êtes pas à l'origine de cette demande, ne communiquez ce code à personne et changez votre mot de passe.\n\n" +
    '---\n' +
    `Your code to permanently delete your RedView account is ${code} (valid 10 minutes). If you did not request it, do not share it and change your password.`;
  const digits = code.split('').map((digit) => `
                  <td style="padding: 0 4px;">
                    <div class="digit-box" style="width: 44px; height: 56px; line-height: 56px; background-color: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 12px; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 26px; font-weight: 700; color: #0f172a; text-align: center; display: block;">${escapeHtml(digit)}</div>
                  </td>`).join('');
  const html = accountEmailHtml({
    title: 'Suppression de votre compte',
    preheader: `${code} : code de suppression de votre compte RedView. Valable 10 minutes.`,
    bodyHtml: `
              <p class="text-body" style="margin: 0 0 28px; font-size: 14px; line-height: 22px; color: #475569;">
                ${escapeHtml(greeting)}<br>
                Voici le code qui confirme la <strong>suppression définitive</strong> de votre compte RedView :
              </p>
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin: 0 auto 24px;">
                <tr>${digits}
                </tr>
              </table>
              <p class="text-muted" style="margin: 0 0 24px; font-size: 13px; line-height: 20px; color: #64748b;">
                Ce code expire dans <strong style="font-weight: 600;">10 minutes</strong>. Vos projets, fichiers FIT, dossiers,
                partages et votre abonnement seront effacés : c'est irréversible.
              </p>
              <p class="text-muted" style="margin: 0 0 24px; font-size: 12px; line-height: 18px; color: #94a3b8;">
                Si vous n'êtes pas à l'origine de cette demande, ne communiquez ce code à personne et changez votre mot de passe.
              </p>`,
  });
  return sendTransactionalEmail('ACCOUNT-DELETION', { to, subject, text, html });
}

/** Accusé de suppression, envoyé une fois le compte effacé. */
export async function sendAccountDeletedEmail({ to, name }: { to: string; name?: string }): Promise<{ sent: boolean }> {
  const greeting = greetingFor(name);
  const subject = 'Votre compte RedView a été supprimé';
  const deletedOn = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' });
  const text =
    `${greeting}\n\n` +
    `Votre compte RedView et ses données ont été supprimés le ${deletedOn} : projets, fichiers FIT, miniatures, dossiers, ` +
    'vues, partages et données de facturation chez notre prestataire de paiement.\n\n' +
    'Les sauvegardes chiffrées du service sont effacées par rotation, au plus tard 12 mois après cette date. ' +
    "Les commentaires et modifications que vous avez apportés aux projets partagés d'autres personnes restent dans ces projets.\n\n" +
    'Merci d’avoir utilisé RedView.\n\n' +
    '---\n' +
    'Your RedView account and its data have been deleted. Encrypted service backups are rotated out within 12 months.';
  const html = accountEmailHtml({
    title: 'Compte supprimé',
    preheader: 'Votre compte RedView et ses données ont été supprimés.',
    bodyHtml: `
              <p class="text-body" style="margin: 0 0 20px; font-size: 14px; line-height: 22px; color: #475569;">
                ${escapeHtml(greeting)}<br>
                Votre compte RedView et ses données ont été supprimés le ${escapeHtml(deletedOn)} : projets, fichiers FIT,
                miniatures, dossiers, vues, partages et données de facturation chez notre prestataire de paiement.
              </p>
              <p class="text-muted" style="margin: 0 0 24px; font-size: 12px; line-height: 18px; color: #94a3b8;">
                Les sauvegardes chiffrées du service sont effacées par rotation, au plus tard 12 mois après cette date.
                Vos commentaires et modifications dans les projets partagés d'autres personnes restent dans ces projets.
              </p>`,
  });
  return sendTransactionalEmail('ACCOUNT-DELETED', { to, subject, text, html });
}

// ─────────────────────────── Abonnement ───────────────────────────
// Envoyés par le webhook Stripe (api/stripe/webhook.ts) : ils couvrent les
// actions faites dans l'app comme dans le portail client Stripe. Reçus et
// factures restent envoyés par Stripe.

function subscriptionLinkHtml(url: string, label: string): string {
  return `
              <p style="margin: 0 0 24px;">
                <a href="${escapeHtml(url)}" style="display: inline-block; padding: 11px 20px; border-radius: 10px; background-color: #890000; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none;">${escapeHtml(label)}</a>
              </p>`;
}

function subscriptionParagraphHtml(text: string): string {
  return `
              <p class="text-body" style="margin: 0 0 20px; font-size: 14px; line-height: 22px; color: #475569;">${text}</p>`;
}

type SubscriptionEmailBase = { to: string; name?: string; planLabel: string; manageUrl: string };

/** Confirmation de résiliation sur support durable (art. L.215-1-1 du Code de la consommation). */
export async function sendSubscriptionCanceledEmail({ to, name, planLabel, endDate, manageUrl }: SubscriptionEmailBase & { endDate: string }): Promise<{ sent: boolean }> {
  const greeting = greetingFor(name);
  const subject = 'Résiliation de votre abonnement RedView confirmée';
  const text =
    `${greeting}\n\n` +
    `Nous confirmons la résiliation de votre abonnement RedView (${planLabel}). ` +
    `Votre contrat prend fin le ${endDate} : vous gardez l'accès jusqu'à cette date et aucun autre prélèvement ne sera effectué.\n\n` +
    `Vous avez changé d'avis ? Vous pouvez reprendre votre abonnement avant cette date : ${manageUrl}\n\n` +
    '---\n' +
    `Your RedView subscription (${planLabel}) is cancelled. It ends on ${endDate}; you keep access until then and will not be charged again.`;
  const html = accountEmailHtml({
    title: 'Résiliation confirmée',
    preheader: `Votre abonnement RedView prend fin le ${endDate}.`,
    bodyHtml:
      subscriptionParagraphHtml(
        `${escapeHtml(greeting)}<br>Nous confirmons la résiliation de votre abonnement RedView (${escapeHtml(planLabel)}). ` +
          `Votre contrat prend fin le <strong>${escapeHtml(endDate)}</strong> : vous gardez l'accès jusqu'à cette date et aucun autre prélèvement ne sera effectué.`,
      ) + subscriptionLinkHtml(manageUrl, 'Reprendre mon abonnement'),
  });
  return sendTransactionalEmail('SUBSCRIPTION-CANCELED', { to, subject, text, html });
}

/** Rappel avant la fin de l'essai gratuit (évènement Stripe `trial_will_end`, 3 jours avant). */
export async function sendTrialEndingEmail({ to, name, planLabel, amount, chargeDate, manageUrl }: SubscriptionEmailBase & { amount: string; chargeDate: string }): Promise<{ sent: boolean }> {
  const greeting = greetingFor(name);
  const subject = `Votre essai RedView se termine le ${chargeDate}`;
  const text =
    `${greeting}\n\n` +
    `Votre essai gratuit de RedView se termine le ${chargeDate}. Sauf résiliation avant cette date, ${amount} seront prélevés ` +
    `ce jour-là pour votre abonnement (${planLabel}), puis à chaque échéance.\n\n` +
    `Résilier votre contrat ou changer de formule : ${manageUrl}\n\n` +
    '---\n' +
    `Your RedView free trial ends on ${chargeDate}. Unless you cancel before then, you will be charged ${amount} (${planLabel}).`;
  const html = accountEmailHtml({
    title: 'Votre essai se termine bientôt',
    preheader: `${amount} seront prélevés le ${chargeDate}, sauf résiliation.`,
    bodyHtml:
      subscriptionParagraphHtml(
        `${escapeHtml(greeting)}<br>Votre essai gratuit de RedView se termine le <strong>${escapeHtml(chargeDate)}</strong>. ` +
          `Sauf résiliation avant cette date, <strong>${escapeHtml(amount)}</strong> seront prélevés ce jour-là pour votre abonnement (${escapeHtml(planLabel)}), puis à chaque échéance.`,
      ) + subscriptionLinkHtml(manageUrl, 'Gérer mon abonnement'),
  });
  return sendTransactionalEmail('TRIAL-ENDING', { to, subject, text, html });
}

/**
 * Information avant reconduction tacite des formules 6 mois et 1 an
 * (art. L.215-1 : entre 3 mois et 1 mois avant la fin de la période).
 */
export async function sendRenewalReminderEmail({ to, name, planLabel, amount, renewalDate, manageUrl }: SubscriptionEmailBase & { amount: string; renewalDate: string }): Promise<{ sent: boolean }> {
  const greeting = greetingFor(name);
  const subject = `Votre abonnement RedView sera reconduit le ${renewalDate}`;
  const text =
    `${greeting}\n\n` +
    `Votre abonnement RedView (${planLabel}) sera reconduit automatiquement le ${renewalDate} pour ${amount}. ` +
    'Vous pouvez choisir de ne pas le reconduire : il suffit de le résilier avant cette date, depuis votre compte.\n\n' +
    `Résilier votre contrat : ${manageUrl}\n\n` +
    '---\n' +
    `Your RedView subscription (${planLabel}) renews on ${renewalDate} for ${amount}. You can cancel it before that date from your account.`;
  const html = accountEmailHtml({
    title: 'Reconduction de votre abonnement',
    preheader: `Reconduction le ${renewalDate} pour ${amount}.`,
    bodyHtml:
      subscriptionParagraphHtml(
        `${escapeHtml(greeting)}<br>Votre abonnement RedView (${escapeHtml(planLabel)}) sera reconduit automatiquement le <strong>${escapeHtml(renewalDate)}</strong> pour <strong>${escapeHtml(amount)}</strong>. ` +
          'Vous pouvez choisir de ne pas le reconduire : il suffit de le résilier avant cette date, depuis votre compte.',
      ) + subscriptionLinkHtml(manageUrl, 'Résilier votre contrat'),
  });
  return sendTransactionalEmail('RENEWAL-REMINDER', { to, subject, text, html });
}
