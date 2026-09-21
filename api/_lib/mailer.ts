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

export async function sendVerificationEmail({
  to,
  code,
  name,
}: SendVerificationEmailOptions): Promise<{ sent: boolean; debugCode?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'RedView <noreply@redview.tech>';
  const rawRecipientName = name || to.split('@')[0] || 'Aventurier';
  const recipientName = escapeHtml(rawRecipientName);

  const maskedEmail = to.replace(/^(.)(.*)(@.*)$/, (_, first, middle, domain) => `${first}${'*'.repeat(Math.min(middle.length, 5))}${domain}`);
  console.log(`[AUTH] 📧 Dispatching verification email to ${maskedEmail}`);

  if (!apiKey) {
    console.warn('[AUTH] RESEND_API_KEY is not configured.');
    return { sent: false };
  }

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
      .digit-box { width: 46px !important; height: 54px !important; font-size: 26px !important; }
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
                    <td style="padding: 0 6px;">
                      <div class="digit-box" style="width: 54px; height: 62px; line-height: 62px; background-color: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 12px; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 30px; font-weight: 700; color: #0f172a; text-align: center; display: block;">
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

  try {
    let response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `${code} est votre code de vérification RedView`,
        text: `Votre code de vérification RedView est : ${code}. Il expire dans 10 minutes.`,
        html,
      }),
    });

    let data = await response.json().catch(() => ({}));

    // If custom domain is not yet verified and we're sending during test/propagation, attempt fallback
    if (!response.ok && from !== 'RedView <onboarding@resend.dev>') {
      console.warn(`[AUTH] Resend sending from ${from} returned ${response.status} (${data?.message}). Testing fallback to onboarding@resend.dev...`);
      const fallbackResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'RedView <onboarding@resend.dev>',
          to: [to],
          subject: `${code} est votre code de vérification RedView`,
          text: `Votre code de vérification RedView est : ${code}. Il expire dans 10 minutes.`,
          html,
        }),
      });
      const fallbackData = await fallbackResponse.json().catch(() => ({}));
      if (fallbackResponse.ok) {
        response = fallbackResponse;
        data = fallbackData;
      }
    }

    if (!response.ok) {
      console.warn('[AUTH] Resend API response error:', data);
      return { sent: false };
    }

    console.log('[AUTH] ✅ Verification email sent via Resend, id:', data?.id);
    return { sent: true };
  } catch (err) {
    console.error('[AUTH] Failed to send email via Resend:', err);
    return { sent: false };
  }
}

export interface SendFeedbackNotificationEmailOptions {
  type: string;
  feature?: string;
  message: string;
  email?: string;
  name?: string;
  context?: {
    url?: string;
    userAgent?: string;
  };
}

export async function sendFeedbackNotificationEmail({
  type,
  feature = 'Général',
  message,
  email,
  name,
  context,
}: SendFeedbackNotificationEmailOptions): Promise<{ sent: boolean; id?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'RedView <noreply@redview.tech>';
  const recipient = process.env.FEEDBACK_RECIPIENT_EMAIL || 'redview.app@proton.me';

  if (!apiKey) {
    console.warn('[FEEDBACK] RESEND_API_KEY not configured. Feedback recorded in logs.');
    console.log(`[FEEDBACK] Type: ${type} | Feature: ${feature} | From: ${name || 'Anonyme'} (${email || 'Sans email'})\nMessage: ${message}`);
    return { sent: false };
  }

  const cleanType = escapeHtml(type);
  const cleanFeature = escapeHtml(feature);
  const cleanMessage = escapeHtml(message);
  const cleanName = escapeHtml(name || 'Utilisateur RedView');
  const cleanEmail = escapeHtml(email || 'Non renseigné');
  const cleanUrl = escapeHtml(context?.url || 'app.redview.tech');
  const cleanUserAgent = escapeHtml(context?.userAgent || 'Non renseigné');
  const submittedAt = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

  const isBug = type.toLowerCase().includes('bug');
  const badgeColor = isBug ? '#ef4444' : '#3b82f6';
  const badgeBg = isBug ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)';

  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Retour utilisateur RedView</title>
  <style>
    body { background-color: #0b0c10; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px; }
    .container { max-width: 580px; margin: 0 auto; background: #13151b; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 28px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 6px; background: ${badgeBg}; color: ${badgeColor}; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    h1 { font-size: 18px; font-weight: 700; color: #ffffff; margin: 0 0 16px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 12px; }
    .field { margin-bottom: 10px; font-size: 13px; line-height: 1.5; }
    .label { color: #64748b; font-weight: 500; display: inline-block; min-width: 110px; }
    .value { color: #f8fafc; font-weight: 600; }
    .message-box { margin-top: 16px; padding: 16px; background: #0a0b0e; border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; font-size: 14px; line-height: 1.6; color: #ffffff; white-space: pre-wrap; word-break: break-word; }
    .footer { margin-top: 24px; padding-top: 14px; border-top: 1px solid rgba(255, 255, 255, 0.06); font-size: 11px; color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">${cleanType}</div>
    <h1>Nouveau retour RedView App : ${cleanFeature}</h1>
    <div class="field"><span class="label">Utilisateur :</span> <span class="value">${cleanName}</span></div>
    <div class="field"><span class="label">E-mail :</span> <span class="value">${cleanEmail}</span></div>
    <div class="field"><span class="label">Section :</span> <span class="value">${cleanFeature}</span></div>
    <div class="field"><span class="label">URL :</span> <span class="value">${cleanUrl}</span></div>
    <div class="message-box">${cleanMessage}</div>
    <div class="footer">
      Soumis le ${submittedAt} | Navigateur : ${cleanUserAgent}
    </div>
  </div>
</body>
</html>
  `.trim();

  try {
    let response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: `[RedView Feedback] [${type}] ${feature} - ${cleanName}`,
        text: `Nouveau retour RedView:\n\nType: ${type}\nModule: ${feature}\nDe: ${cleanName} (${cleanEmail})\n\nMessage:\n${message}\n\nDate: ${submittedAt}\nURL: ${cleanUrl}`,
        html,
      }),
    });

    let data = await response.json().catch(() => ({}));

    if (!response.ok && from !== 'RedView <onboarding@resend.dev>') {
      const fallbackResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'RedView <onboarding@resend.dev>',
          to: [recipient],
          subject: `[RedView Feedback] [${type}] ${feature} - ${cleanName}`,
          text: `Nouveau retour RedView:\n\nType: ${type}\nModule: ${feature}\nDe: ${cleanName} (${cleanEmail})\n\nMessage:\n${message}\n\nDate: ${submittedAt}`,
          html,
        }),
      });
      if (fallbackResponse.ok) {
        response = fallbackResponse;
        data = await fallbackResponse.json().catch(() => ({}));
      }
    }

    if (!response.ok) {
      console.warn('[FEEDBACK] Resend delivery warning:', data);
      return { sent: false };
    }

    console.log('[FEEDBACK] ✅ Feedback email sent via Resend, id:', data?.id);
    return { sent: true, id: data?.id };
  } catch (err) {
    console.error('[FEEDBACK] Failed to send feedback email:', err);
    return { sent: false };
  }
}

