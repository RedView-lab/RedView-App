import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import { getAppwriteEndpoint, getAppwriteProjectId } from '../_lib/appwrite.js';
import { parseEmailAddress } from '../_lib/email.js';
import { bodyFields } from '../_lib/http.js';

// Liste blanche EXACTE (plus de correspondance générique `*.redview.tech`) :
// le lien de récupération Appwrite embarque userId + secret, il ne doit
// pointer que vers l'app (window.location.origin côté client) ou la landing.
const ALLOWED_REDIRECT_HOSTS = new Set(['app.redview.tech', 'redview.tech', 'www.redview.tech']);
const DEV_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1']);
const DEFAULT_REDIRECT_URL = 'https://app.redview.tech/';

const RECOVERY_TIMEOUT_MS = 10_000;
/** Durée fixe de la réponse, que le compte existe ou non (anti-énumération par le temps). */
const RESPONSE_DELAY_MS = 300;

const NEUTRAL_SUCCESS_MESSAGE =
  'Si un compte est associé à cette adresse e-mail, un lien de réinitialisation vous a été envoyé.';

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

function resolveRedirectUrl(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_REDIRECT_URL;
  try {
    const parsed = new URL(raw);
    return isAllowedRedirect(parsed) ? parsed.toString() : DEFAULT_REDIRECT_URL;
  } catch {
    return DEFAULT_REDIRECT_URL;
  }
}

/**
 * Demande à Appwrite l'e-mail de récupération. Une adresse sans compte
 * répond 404 (attendu, silencieux) ; tout autre échec est journalisé : la
 * personne reçoit la réponse neutre de toute façon.
 */
async function dispatchRecovery(email: string, redirectUrl: string): Promise<void> {
  try {
    const response = await fetch(`${getAppwriteEndpoint()}/account/recovery`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Appwrite-Project': getAppwriteProjectId(),
      },
      body: JSON.stringify({ email, url: redirectUrl }),
      signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '');
      console.error(`[forgot-password] Appwrite recovery HTTP ${response.status}:`, detail.slice(0, 200));
    }
  } catch (error) {
    console.error('[forgot-password] Appwrite recovery request failed:', error);
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { email, redirectUrl } = bodyFields(req);
  const trimmedEmail = parseEmailAddress(email);
  if (!trimmedEmail) {
    return res.status(400).json({ error: 'Veuillez fournir une adresse e-mail valide.' });
  }

  // La demande part sans être attendue : la réponse prend toujours le même
  // temps, qu'Appwrite envoie un e-mail (compte existant) ou réponde 404.
  void dispatchRecovery(trimmedEmail, resolveRedirectUrl(redirectUrl));
  await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));

  // Anti-énumération : même réponse dans tous les cas.
  return res.status(200).json({ success: true, message: NEUTRAL_SUCCESS_MESSAGE });
}
