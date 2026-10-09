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
// Un seul gabarit pour tous les e-mails : en-tête sombre de l'app (#0e0e12,
// le fond du thème d'origine) avec le logo, filet rouge RedView (#890000),
// carte blanche lisible, pied de page avec les liens utiles. Tables et styles
// en ligne (Gmail, Outlook) ; le mode sombre des clients qui le gèrent passe
// par les classes `rv-*`. Toute valeur interpolée passe par `escapeHtml`.

const BRAND_RED = '#890000';
const BRAND_DARK = '#0e0e12';
const FONT_STACK = "'Rethink Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || 'https://app.redview.tech').replace(/\/+$/, '');
}

/**
 * Espaces insécables de la typographie française (avant « : ; ! ? » », après
 * « « ») : un deux-points ne se retrouve jamais seul en début de ligne. Ne
 * s'applique qu'au texte rédigé ici (pas d'attributs dans ces fragments).
 */
function frenchSpacing(html: string): string {
  return html.replace(/ ([:;!?»])/g, '&nbsp;$1').replace(/« /g, '«&nbsp;');
}

/** Paragraphe principal (HTML déjà échappé par l'appelant). */
function paragraphHtml(html: string, marginBottom = 20): string {
  return `
              <p class="rv-text" style="margin: 0 0 ${marginBottom}px; font-size: 15px; line-height: 24px; color: #3f3f46;">${frenchSpacing(html)}</p>`;
}

/** Texte secondaire (HTML déjà échappé). */
function noteHtml(html: string): string {
  return `
              <p class="rv-muted" style="margin: 0 0 20px; font-size: 13px; line-height: 20px; color: #71717a;">${frenchSpacing(html)}</p>`;
}

/** Encadré d'avertissement (sécurité, action irréversible), HTML déjà échappé. */
function calloutHtml(html: string): string {
  return `
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 0 0 24px; border-collapse: separate;">
                <tr>
                  <td class="rv-callout" style="padding: 14px 16px; background-color: #fbf5f5; border-left: 3px solid ${BRAND_RED}; border-radius: 0 8px 8px 0; font-size: 13px; line-height: 20px; color: #52525b;">${frenchSpacing(html)}</td>
                </tr>
              </table>`;
}

/**
 * Code à usage unique : un seul bloc (sélectionnable et copiable d'un coup,
 * contrairement à des cases séparées), chiffres espacés, durée de validité.
 */
function codeBlockHtml(code: string, validityHtml: string): string {
  return `
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 4px 0 12px; border-collapse: separate;">
                <tr>
                  <td align="center" class="rv-code" style="padding: 20px 2px 20px 12px; background-color: #f6f6f8; border: 1px solid #e4e4e7; border-radius: 12px; font-family: ${MONO_STACK}; font-size: 34px; line-height: 40px; font-weight: 700; letter-spacing: 10px; color: #111114;">${escapeHtml(code)}</td>
                </tr>
              </table>
              <p class="rv-muted" style="margin: 0 0 28px; font-size: 13px; line-height: 20px; color: #71717a; text-align: center;">${validityHtml}</p>`;
}

/** Bouton d'action (lien absolu). */
function buttonHtml(url: string, label: string): string {
  return `
              <table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin: 4px 0 28px;">
                <tr>
                  <td align="center" bgcolor="${BRAND_RED}" style="border-radius: 10px; background-color: ${BRAND_RED};">
                    <a href="${escapeHtml(url)}" target="_blank" style="display: inline-block; padding: 13px 26px; font-family: ${FONT_STACK}; font-size: 15px; line-height: 20px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 10px;">${escapeHtml(label)}</a>
                  </td>
                </tr>
              </table>`;
}

/** Résumé en anglais en bas de carte (les e-mails partent en français). */
function englishSummaryHtml(text: string): string {
  return `
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 8px 0 0;">
                <tr>
                  <td class="rv-divider" lang="en" style="border-top: 1px solid #ececef; padding-top: 16px; font-size: 12px; line-height: 18px; color: #8a8a93;">${escapeHtml(text)}</td>
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
  const logoUrl = `${appUrl}/brand/redview-email-logo.png`;
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" target="_blank" class="rv-footer-link" style="color: #52525b; text-decoration: underline;">${escapeHtml(label)}</a>`;
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
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; -webkit-font-smoothing: antialiased; }
    table { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a { color: ${BRAND_RED}; }
    @media (prefers-color-scheme: dark) {
      .rv-page { background-color: #070709 !important; }
      .rv-card { background-color: #16161b !important; border-color: #26262e !important; }
      .rv-title { color: #ffffff !important; }
      .rv-text { color: #d4d4d8 !important; }
      .rv-text strong { color: #ffffff !important; }
      .rv-muted { color: #a1a1aa !important; }
      .rv-code { background-color: #1f1f26 !important; border-color: #33333d !important; color: #ffffff !important; }
      .rv-callout { background-color: #241517 !important; color: #d4d4d8 !important; }
      .rv-divider { border-color: #26262e !important; color: #8a8a93 !important; }
      .rv-footer, .rv-footer-link { color: #8a8a93 !important; }
    }
    @media only screen and (max-width: 520px) {
      .rv-shell { padding: 20px 10px !important; }
      .rv-header { padding: 22px 22px !important; }
      .rv-body { padding: 28px 22px 24px !important; }
      .rv-code { font-size: 28px !important; letter-spacing: 7px !important; }
    }
  </style>
</head>
<body class="rv-page" style="margin: 0; padding: 0; background-color: #f2f2f4; font-family: ${FONT_STACK};">
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; mso-hide: all;">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="rv-page" style="background-color: #f2f2f4;">
    <tr>
      <td align="center" class="rv-shell" style="padding: 40px 16px;">
        <!--[if mso]><table role="presentation" width="560" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" class="rv-card" style="max-width: 560px; width: 100%; background-color: #ffffff; border: 1px solid #e4e4e7; border-radius: 16px; overflow: hidden;">
          <tr>
            <td class="rv-header" bgcolor="${BRAND_DARK}" style="padding: 26px 36px; background-color: ${BRAND_DARK};">
              <a href="${escapeHtml(`${appUrl}/`)}" target="_blank" style="text-decoration: none;"><img src="${escapeHtml(logoUrl)}" width="130" height="24" alt="RedView" style="display: block; width: 130px; height: 24px; color: #ffffff; font-family: ${FONT_STACK}; font-size: 18px; font-weight: 700;"></a>
            </td>
          </tr>
          <tr>
            <td bgcolor="${BRAND_RED}" style="height: 3px; line-height: 3px; font-size: 3px; background-color: ${BRAND_RED};">&nbsp;</td>
          </tr>
          <tr>
            <td class="rv-body" style="padding: 36px 36px 30px; text-align: left; font-family: ${FONT_STACK};">
              <h1 class="rv-title" style="margin: 0 0 16px; font-family: ${FONT_STACK}; font-size: 23px; line-height: 30px; font-weight: 700; letter-spacing: -0.01em; color: #111114;">${escapeHtml(title)}</h1>
              ${bodyHtml}${englishSummary ? englishSummaryHtml(englishSummary) : ''}
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 560px; width: 100%;">
          <tr>
            <td class="rv-footer" style="padding: 24px 24px 8px; text-align: center; font-family: ${FONT_STACK}; font-size: 12px; line-height: 20px; color: #71717a;">
              RedView · Planification et analyse d’itinéraires en 3D<br>
              ${link(`${appUrl}/`, 'Ouvrir RedView')} &nbsp;·&nbsp; ${link(`mailto:${supportEmail()}`, 'Nous contacter')} &nbsp;·&nbsp; ${link(`${appUrl}/confidentialite`, 'Confidentialité')} &nbsp;·&nbsp; ${link(`${appUrl}/mentions-legales`, 'Mentions légales')}
            </td>
          </tr>
          <tr>
            <td class="rv-footer" style="padding: 0 24px 8px; text-align: center; font-family: ${FONT_STACK}; font-size: 11px; line-height: 17px; color: #a1a1aa;">
              E-mail automatique lié à votre compte RedView&nbsp;: merci de ne pas y répondre.
            </td>
          </tr>
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

const CODE_VALIDITY_HTML = 'Ce code est valable <strong>10 minutes</strong>.';

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
