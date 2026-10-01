import type { ApiRequest, ApiResponse } from '../_lib/types.js';

function getEndpoint(): string {
  return (
    process.env.APPWRITE_ENDPOINT ||
    process.env.VITE_APPWRITE_ENDPOINT ||
    'https://appwrite.redview.tech/v1'
  );
}

function getProjectId(): string {
  return (
    process.env.APPWRITE_PROJECT_ID ||
    process.env.VITE_APPWRITE_PROJECT_ID ||
    'redview-prod'
  );
}

// Liste blanche EXACTE (plus de correspondance générique `*.redview.tech`) :
// le lien de récupération Appwrite embarque userId + secret, il ne doit
// pointer que vers l'app (window.location.origin côté client) ou la landing.
const ALLOWED_REDIRECT_HOSTS = new Set(['app.redview.tech', 'redview.tech', 'www.redview.tech']);
const DEV_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1']);

function isAllowedRedirect(url: URL): boolean {
  if (url.username || url.password) return false;
  // Dev local (http ou https, port libre) uniquement hors production.
  if (DEV_REDIRECT_HOSTS.has(url.hostname)) {
    return (
      process.env.NODE_ENV !== 'production' &&
      (url.protocol === 'http:' || url.protocol === 'https:')
    );
  }
  return url.protocol === 'https:' && url.port === '' && ALLOWED_REDIRECT_HOSTS.has(url.hostname);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, redirectUrl } = req.body || {};
  const trimmedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  // 1. Strict email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
    return res.status(400).json({ error: 'Veuillez fournir une adresse e-mail valide.' });
  }

  // 2. Open redirect prevention: only permit approved application origins
  let safeRedirectUrl = 'https://app.redview.tech/';
  if (typeof redirectUrl === 'string') {
    try {
      const parsed = new URL(redirectUrl);
      if (isAllowedRedirect(parsed)) {
        safeRedirectUrl = parsed.toString();
      }
    } catch {
      // ignore invalid URLs and fallback to default
    }
  }

  const startTime = Date.now();

  try {
    const endpoint = getEndpoint();
    const projectId = getProjectId();

    // Call Appwrite account recovery endpoint
    await fetch(`${endpoint}/account/recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Appwrite-Project': projectId,
      },
      body: JSON.stringify({
        email: trimmedEmail,
        url: safeRedirectUrl,
      }),
    });

    // 3. Timing-attack mitigation: ensure uniform response time (minimum 300ms)
    const elapsed = Date.now() - startTime;
    if (elapsed < 300) {
      await new Promise((resolve) => setTimeout(resolve, 300 - elapsed));
    }

    // 4. Anti-enumeration: always return generic success (OWASP ASVS compliance)
    return res.status(200).json({
      success: true,
      message:
        'Si un compte est associé à cette adresse e-mail, un lien de réinitialisation vous a été envoyé.',
    });
  } catch (error) {
    console.error('[forgot-password] Internal recovery dispatch error:', error);
    // Timing defense even in case of error
    const elapsed = Date.now() - startTime;
    if (elapsed < 300) {
      await new Promise((resolve) => setTimeout(resolve, 300 - elapsed));
    }

    return res.status(200).json({
      success: true,
      message:
        'Si un compte est associé à cette adresse e-mail, un lien de réinitialisation vous a été envoyé.',
    });
  }
}
