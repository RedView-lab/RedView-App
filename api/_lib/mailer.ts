/** Corps JSON renvoyé par l'API Resend (succès : id ; échec : message). */
type ResendResult = { id?: string; message?: string };

interface SendVerificationEmailOptions {
  to: string;
  code: string;
}

/**
 * Salutation des e-mails envoyés avant que la personne ait prouvé posséder
 * l'adresse (code d'inscription, « compte existant ») : jamais le nom saisi
 * dans le formulaire. N'importe qui peut déclencher ces e-mails vers
 * n'importe quelle adresse, et ce nom leur faisait porter 100 caractères de
 * texte libre (« Bonjour Votre compte est suspendu, appelez le… ») sous
 * l'expéditeur officiel de RedView.
 */
const UNVERIFIED_GREETING = 'Bonjour,';

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

// ─────────────────────────── Charte des e-mails ───────────────────────────
// Reprend la DA de l'app (écran de connexion, fenêtre « Vérifiez vos
// e-mails », VerificationCodeModal.css) : fond gris très clair, logo à
// l'encre, carte blanche à filet fin (rayon 12 px, sans ombre marquée), titre
// 18 px Semibold, texte d'accompagnement 14 px à 60 % d'encre, code dans des
// cases à bord de 2 px (48 px Medium), bouton cramoisi #890000 (rayon 8 px),
// petits liens soulignés. Le thème sombre suit les mêmes valeurs que l'app
// (#131313 / #242424) dans les clients qui le gèrent. Tables et styles en
// ligne (Gmail, Outlook) ; toute valeur interpolée passe par `escapeHtml`.

const BRAND_RED = '#890000';
const INK = '#111114';
const INK_60 = '#707072'; // encre à 60 % sur blanc (texte d'accompagnement)
const INK_12 = '#e2e2e3'; // filet de carte : encre à 12 %
const FONT_STACK = "'Rethink Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || 'https://app.redview.tech').replace(/\/+$/, '');
}

/**
 * Espaces insécables de la typographie française (avant « : ; ! ? » », après
 * « « ») : un deux-points ne se retrouve jamais seul en début de ligne. Ne
 * s'applique qu'au texte rédigé ici (pas d'attributs dans ces fragments).
 */
function frenchSpacing(html: string): string {
  return html
    .replace(/ ([:;!?»])/g, '&nbsp;$1')
    .replace(/« /g, '«&nbsp;')
    // « e-mail » ne se coupe jamais au tiret.
    .replace(/\be-mail/g, '<span style="white-space: nowrap;">e-mail</span>');
}

/** Texte d'accompagnement (HTML déjà échappé par l'appelant). */
function paragraphHtml(html: string, marginBottom = 16): string {
  return `
              <p class="rv-muted" style="margin: 0 0 ${marginBottom}px; font-size: 14px; line-height: 20px; color: ${INK_60}; text-align: center;">${frenchSpacing(html)}</p>`;
}

/** Petite mention sous le contenu (HTML déjà échappé). */
function noteHtml(html: string): string {
  return `
              <p class="rv-muted" style="margin: 0 0 4px; font-size: 13px; line-height: 20px; color: ${INK_60}; text-align: center;">${frenchSpacing(html)}</p>`;
}

/** Bandeau d'alerte de l'app (`.rv-modal-error`), HTML déjà échappé. */
function calloutHtml(html: string): string {
  return `
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 0 0 20px; border-collapse: separate;">
                <tr>
                  <td class="rv-alert" style="padding: 8px 12px; background-color: #fcf1f0; border: 1px solid #f3c8c5; border-radius: 8px; font-size: 13px; line-height: 20px; color: #b42318; text-align: center;">${frenchSpacing(html)}</td>
                </tr>
              </table>`;
}

/** Code à usage unique dans les cases de la fenêtre de vérification de l'app. */
function codeBlockHtml(code: string, validityHtml: string): string {
  const cells = code.split('').map((digit, index) => `
                  <td style="padding: 0 ${index === code.length - 1 ? 0 : 8}px 0 0;">
                    <div class="rv-digit" style="width: 50px; height: 64px; line-height: 60px; border: 2px solid #c8c8c9; border-radius: 12px; background-color: #ffffff; font-family: ${FONT_STACK}; font-size: 40px; font-weight: 500; letter-spacing: -0.02em; color: ${INK}; text-align: center; box-sizing: border-box;">${escapeHtml(digit)}</div>
                  </td>`).join('');
  return `
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" align="center" style="margin: 8px auto 16px; border-collapse: separate;">
                <tr>${cells}
                </tr>
              </table>
              <p class="rv-muted" style="margin: 0 0 24px; font-size: 14px; line-height: 20px; color: ${INK_60}; text-align: center;">${frenchSpacing(validityHtml)}</p>`;
}

/** Bouton principal de l'app (`.rv-modal-btn-confirm`), pleine largeur. */
function buttonHtml(url: string, label: string): string {
  return `
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 8px 0 20px; border-collapse: separate;">
                <tr>
                  <td align="center" bgcolor="${BRAND_RED}" style="border-radius: 8px; background-color: ${BRAND_RED};">
                    <a href="${escapeHtml(url)}" target="_blank" style="display: block; padding: 11px 16px; font-family: ${FONT_STACK}; font-size: 14px; line-height: 20px; font-weight: 500; color: #ffffff; text-decoration: none; border-radius: 8px;">${escapeHtml(label)}</a>
                  </td>
                </tr>
              </table>`;
}

/**
 * Gabarit commun. `bodyHtml` est déjà échappé ; `title`, `preheader` et
 * `englishSummary` le sont ici. Le pied de page ne contient aucune donnée du
 * destinataire.
 */
function emailLayout({ title, preheader, bodyHtml, englishSummary }: {
  title: string;
  preheader: string;
  bodyHtml: string;
  englishSummary?: string;
}): string {
  const appUrl = appBaseUrl();
  // Le logo blanc (thème sombre) n'a pas de texte alternatif : sinon l'aperçu
  // des messageries, qui lit le texte de tout le message, affichait « RedView RedView ».
  const logo = (file: string, cls: string, extra = '', alt = 'RedView') =>
    `<img src="${escapeHtml(`${appUrl}/brand/${file}`)}" width="130" height="24" alt="${alt}" class="${cls}" style="display: block; width: 130px; height: 24px; border: 0; outline: none; color: ${INK}; font-family: ${FONT_STACK}; font-size: 18px; font-weight: 700;${extra}">`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" target="_blank" class="rv-link" style="color: ${INK_60}; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap;">${escapeHtml(label)}</a>`;
  return `
<!DOCTYPE html>
<html lang="fr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(title)}</title>
  <!--[if mso]><style>* { font-family: Arial, sans-serif !important; }</style><![endif]-->
  <!--[if !mso]><!-->
  <style>
    @font-face { font-family: 'Rethink Sans'; font-style: normal; font-weight: 400 800; src: url('${escapeHtml(`${appUrl}/brand/fonts/rethink-sans-latin-wght-normal.woff2`)}') format('woff2'); }
  </style>
  <!--<![endif]-->
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; -webkit-font-smoothing: antialiased; }
    table { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .rv-logo-dark { display: none; }
    @media (prefers-color-scheme: dark) {
      .rv-page { background-color: #131313 !important; }
      .rv-card { background-color: #242424 !important; border-color: #3a3a3a !important; }
      .rv-title { color: #ffffff !important; }
      .rv-muted, .rv-link { color: #a7a7a7 !important; }
      .rv-muted strong { color: #ffffff !important; }
      .rv-digit { background-color: #2f2f2f !important; border-color: #7c7c7c !important; color: #ffffff !important; }
      .rv-alert { background-color: #3a2222 !important; border-color: #5c2f2f !important; color: #fca5a5 !important; }
      .rv-logo-light { display: none !important; }
      .rv-logo-dark { display: block !important; }
    }
    @media only screen and (max-width: 480px) {
      .rv-shell { padding: 28px 12px !important; }
      .rv-body { padding: 24px 18px !important; }
      .rv-digit { width: 40px !important; height: 54px !important; line-height: 50px !important; font-size: 32px !important; }
    }
  </style>
</head>
<body class="rv-page" style="margin: 0; padding: 0; background-color: #f6f6f6; font-family: ${FONT_STACK};">
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all;">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="rv-page" style="background-color: #f6f6f6;">
    <tr>
      <td align="center" class="rv-shell" style="padding: 40px 16px;">
        <!--[if mso]><table role="presentation" width="440" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 440px; width: 100%; border-collapse: separate;">
          <tr>
            <td style="padding: 0 4px 28px;">
              <a href="${escapeHtml(`${appUrl}/`)}" target="_blank" style="text-decoration: none;">${logo('redview-email-logo.png', 'rv-logo-light')}${logo('redview-email-logo-white.png', 'rv-logo-dark', ' display: none; mso-hide: all;', '')}</a>
            </td>
          </tr>
          <tr>
            <td class="rv-card" style="background-color: #ffffff; border: 1px solid ${INK_12}; border-radius: 12px;">
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td class="rv-body" style="padding: 28px 24px 24px; font-family: ${FONT_STACK};">
                    <h1 class="rv-title" style="margin: 0 0 6px; font-family: ${FONT_STACK}; font-size: 18px; line-height: 28px; font-weight: 600; color: ${INK}; text-align: center;">${escapeHtml(title)}</h1>
                    ${bodyHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td class="rv-muted" style="padding: 20px 8px 0; text-align: center; font-family: ${FONT_STACK}; font-size: 12px; line-height: 18px; color: ${INK_60};">
              ${link(`${appUrl}/`, 'Ouvrir RedView')} &nbsp;&nbsp; ${link(`mailto:${supportEmail()}`, 'Nous contacter')} &nbsp;&nbsp; ${link(`${appUrl}/confidentialite`, 'Confidentialité')} &nbsp;&nbsp; ${link(`${appUrl}/mentions-legales`, 'Mentions légales')}
            </td>
          </tr>${englishSummary ? `
          <tr>
            <td class="rv-muted" lang="en" style="padding: 14px 8px 0; text-align: center; font-family: ${FONT_STACK}; font-size: 11px; line-height: 16px; color: #9a9a9b;">${escapeHtml(englishSummary)}</td>
          </tr>` : ''}
        </table>
        <!--[if mso]></td></tr></table><![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/** Adresse de contact de RedView (aussi dans les mentions légales) ; SUPPORT_EMAIL la remplace. */
const DEFAULT_SUPPORT_EMAIL = 'redview.app@proton.me';

function supportEmail(): string {
  return process.env.SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
}

function greetingFor(name?: string): string {
  const cleanName = name && name.trim().length > 0 && !name.includes('@') ? name.trim() : '';
  return cleanName ? `Bonjour ${cleanName},` : 'Bonjour,';
}

const CODE_VALIDITY_HTML = 'Ce code expire dans 10 minutes.';

// ─────────────────────────── Inscription ───────────────────────────

export async function sendVerificationEmail({
  to,
  code,
}: SendVerificationEmailOptions): Promise<{ sent: boolean }> {
  const greeting = UNVERIFIED_GREETING;
  const html = emailLayout({
    title: 'Votre code de vérification',
    preheader: `${code} est votre code de vérification RedView. Valable 10 minutes.`,
    bodyHtml:
      paragraphHtml(`${escapeHtml(greeting)}<br>Saisissez ce code dans RedView pour confirmer votre adresse e-mail et terminer votre inscription :`, 24)
      + codeBlockHtml(code, CODE_VALIDITY_HTML)
      + noteHtml('Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail : aucun compte ne sera créé.'),
    englishSummary: `Your RedView verification code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this e-mail.`,
  });

  return sendTransactionalEmail('AUTH', {
    to,
    subject: `${code} est votre code de vérification RedView`,
    text: `Votre code de vérification RedView est : ${code}. Il expire dans 10 minutes.`,
    html,
  });
}

interface SendAccountExistsEmailOptions {
  to: string;
}

/**
 * Envoyé à la place du code quand une inscription est demandée pour une
 * adresse déjà associée à un compte : l'API répond exactement comme pour un
 * envoi de code (anti-énumération), seul le propriétaire de la boîte voit
 * la différence.
 */
export async function sendAccountExistsEmail({
  to,
}: SendAccountExistsEmailOptions): Promise<{ sent: boolean }> {
  const appUrl = appBaseUrl();

  const greeting = UNVERIFIED_GREETING;
  const subject = 'Vous avez déjà un compte RedView';
  const text =
    `${greeting}\n\n` +
    'Une inscription a été demandée avec cette adresse e-mail, mais un compte RedView existe déjà.\n' +
    `Connectez-vous sur ${appUrl}/ ou, si vous avez oublié votre mot de passe, utilisez « Mot de passe oublié ».\n\n` +
    "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.\n\n" +
    '---\n' +
    'Someone tried to sign up with this e-mail address, but a RedView account already exists. ' +
    `Please log in at ${appUrl}/ or reset your password. If this wasn't you, you can safely ignore this e-mail.`;

  const html = emailLayout({
    title: 'Vous avez déjà un compte',
    preheader: 'Une inscription a été demandée avec votre adresse, mais votre compte RedView existe déjà.',
    bodyHtml:
      paragraphHtml(
        `${escapeHtml(greeting)}<br>Une inscription a été demandée avec cette adresse e-mail, mais un compte RedView existe déjà. `
          + 'Connectez-vous, ou utilisez « Mot de passe oublié » si vous ne vous souvenez plus de votre mot de passe.',
        24,
      )
      + buttonHtml(`${appUrl}/`, 'Se connecter à RedView')
      + noteHtml('Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.'),
    englishSummary: 'Someone tried to sign up with this e-mail address, but a RedView account already exists. Please log in or reset your password. If this wasn’t you, you can safely ignore this e-mail.',
  });

  return sendTransactionalEmail('AUTH', { to, subject, text, html });
}

// ─────────────────────────── Compte ───────────────────────────

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
  const html = emailLayout({
    title: 'Suppression de votre compte',
    preheader: `${code} : code de suppression de votre compte RedView. Valable 10 minutes.`,
    bodyHtml:
      paragraphHtml(`${escapeHtml(greeting)}<br>Voici le code qui confirme la <strong>suppression définitive</strong> de votre compte RedView :`, 24)
      + codeBlockHtml(code, CODE_VALIDITY_HTML)
      + calloutHtml('Vos projets, fichiers FIT, dossiers, partages et votre abonnement seront effacés : c’est <strong>irréversible</strong>.')
      + noteHtml('Si vous n’êtes pas à l’origine de cette demande, ne communiquez ce code à personne et changez votre mot de passe.'),
    englishSummary: `Your code to permanently delete your RedView account is ${code} (valid 10 minutes). If you did not request it, do not share it and change your password.`,
  });
  return sendTransactionalEmail('ACCOUNT-DELETION', { to, subject, text, html });
}

/**
 * Code qui prouve l'accès à la nouvelle adresse d'un compte
 * (api/auth/change-email.ts). Adresse pas encore vérifiée : comme pour
 * l'inscription, rien de saisi librement (nom du compte) dans le contenu.
 */
export async function sendEmailChangeCodeEmail({ to, code }: { to: string; code: string }): Promise<{ sent: boolean }> {
  const subject = `${code} : confirmez votre nouvelle adresse RedView`;
  const text =
    `${UNVERIFIED_GREETING}\n\n` +
    `Votre code pour faire de cette adresse celle de votre compte RedView est : ${code}. Il expire dans 10 minutes.\n\n` +
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : rien ne change.\n\n" +
    '---\n' +
    `Your code to make this address the e-mail of your RedView account is ${code} (valid 10 minutes). If you did not request it, ignore this message.`;
  const html = emailLayout({
    title: 'Confirmez votre nouvelle adresse',
    preheader: `${code} : confirmez votre nouvelle adresse RedView. Valable 10 minutes.`,
    bodyHtml:
      paragraphHtml(`${escapeHtml(UNVERIFIED_GREETING)}<br>Voici le code qui fait de cette adresse celle de votre compte RedView :`, 24)
      + codeBlockHtml(code, CODE_VALIDITY_HTML)
      + noteHtml('Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : rien ne change.'),
    englishSummary: `Your code to make this address the e-mail of your RedView account is ${code} (valid 10 minutes). If you did not request it, ignore this message.`,
  });
  return sendTransactionalEmail('EMAIL-CHANGE-CODE', { to, subject, text, html });
}

/**
 * Avis envoyé à l'ANCIENNE adresse une fois le changement fait : une prise de
 * compte (session volée + mot de passe) ne passe pas inaperçue.
 */
export async function sendEmailChangedNoticeEmail({ to, name, newEmail }: { to: string; name?: string; newEmail: string }): Promise<{ sent: boolean }> {
  const greeting = greetingFor(name);
  const masked = maskEmail(newEmail);
  // Expéditeur noreply : l'avis cite l'adresse de contact de RedView.
  const support = supportEmail();
  const alert = `Si vous n'êtes pas à l'origine de ce changement, écrivez sans attendre à ${support} pour que nous bloquions le compte.`;
  const subject = 'L’adresse de votre compte RedView a changé';
  const text =
    `${greeting}\n\n` +
    `L'adresse e-mail de votre compte RedView est désormais ${masked}. Cette adresse-ci n'y est plus associée.\n\n` +
    `${alert}\n\n` +
    '---\n' +
    `The e-mail address of your RedView account is now ${masked}. If you did not make this change, write to ${support} right away.`;
  const html = emailLayout({
    title: 'Adresse du compte modifiée',
    preheader: `L'adresse de votre compte RedView est désormais ${masked}.`,
    bodyHtml:
      paragraphHtml(
        `${escapeHtml(greeting)}<br>L’adresse e-mail de votre compte RedView est désormais <strong>${escapeHtml(masked)}</strong>. `
          + 'Cette adresse-ci n’y est plus associée.',
        24,
      )
      + calloutHtml(escapeHtml(alert)),
    englishSummary: `The e-mail address of your RedView account is now ${masked}. If you did not make this change, write to ${support} right away.`,
  });
  return sendTransactionalEmail('EMAIL-CHANGED', { to, subject, text, html });
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
  const html = emailLayout({
    title: 'Compte supprimé',
    preheader: 'Votre compte RedView et ses données ont été supprimés.',
    bodyHtml:
      paragraphHtml(
        `${escapeHtml(greeting)}<br>Votre compte RedView et ses données ont été supprimés le <strong>${escapeHtml(deletedOn)}</strong> : `
          + 'projets, fichiers FIT, miniatures, dossiers, vues, partages et données de facturation chez notre prestataire de paiement.',
      )
      + noteHtml(
        'Les sauvegardes chiffrées du service sont effacées par rotation, au plus tard 12 mois après cette date. '
          + 'Vos commentaires et modifications dans les projets partagés d’autres personnes restent dans ces projets.',
      )
      + paragraphHtml('Merci d’avoir utilisé RedView.', 24),
    englishSummary: 'Your RedView account and its data have been deleted. Encrypted service backups are rotated out within 12 months.',
  });
  return sendTransactionalEmail('ACCOUNT-DELETED', { to, subject, text, html });
}

// ─────────────────────────── Abonnement ───────────────────────────
// Envoyés par le webhook Stripe (api/stripe/webhook.ts) : ils couvrent les
// actions faites dans l'app comme dans le portail client Stripe. Reçus et
// factures restent envoyés par Stripe.

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
  const html = emailLayout({
    title: 'Résiliation confirmée',
    preheader: `Votre abonnement RedView prend fin le ${endDate}.`,
    bodyHtml:
      paragraphHtml(
        `${escapeHtml(greeting)}<br>Nous confirmons la résiliation de votre abonnement RedView (${escapeHtml(planLabel)}). `
          + `Votre contrat prend fin le <strong>${escapeHtml(endDate)}</strong> : vous gardez l’accès jusqu’à cette date et aucun autre prélèvement ne sera effectué.`,
      )
      + paragraphHtml('Vous avez changé d’avis ? Vous pouvez reprendre votre abonnement avant cette date.', 24)
      + buttonHtml(manageUrl, 'Reprendre mon abonnement'),
    englishSummary: `Your RedView subscription (${planLabel}) is cancelled. It ends on ${endDate}; you keep access until then and will not be charged again.`,
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
  const html = emailLayout({
    title: 'Votre essai se termine bientôt',
    preheader: `${amount} seront prélevés le ${chargeDate}, sauf résiliation.`,
    bodyHtml:
      paragraphHtml(
        `${escapeHtml(greeting)}<br>Votre essai gratuit de RedView se termine le <strong>${escapeHtml(chargeDate)}</strong>. `
          + `Sauf résiliation avant cette date, <strong>${escapeHtml(amount)}</strong> seront prélevés ce jour-là pour votre abonnement (${escapeHtml(planLabel)}), puis à chaque échéance.`,
        24,
      )
      + buttonHtml(manageUrl, 'Gérer mon abonnement'),
    englishSummary: `Your RedView free trial ends on ${chargeDate}. Unless you cancel before then, you will be charged ${amount} (${planLabel}).`,
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
  const html = emailLayout({
    title: 'Reconduction de votre abonnement',
    preheader: `Reconduction le ${renewalDate} pour ${amount}.`,
    bodyHtml:
      paragraphHtml(
        `${escapeHtml(greeting)}<br>Votre abonnement RedView (${escapeHtml(planLabel)}) sera reconduit automatiquement le <strong>${escapeHtml(renewalDate)}</strong> pour <strong>${escapeHtml(amount)}</strong>. `
          + 'Vous pouvez choisir de ne pas le reconduire : il suffit de le résilier avant cette date, depuis votre compte.',
        24,
      )
      + buttonHtml(manageUrl, 'Résilier votre contrat'),
    englishSummary: `Your RedView subscription (${planLabel}) renews on ${renewalDate} for ${amount}. You can cancel it before that date from your account.`,
  });
  return sendTransactionalEmail('RENEWAL-REMINDER', { to, subject, text, html });
}
