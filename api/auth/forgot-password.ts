import type { ApiRequest, ApiResponse } from '../_lib/types.js';
import { captureServerError } from '../../server/lib/observability.mjs';
import { getAppwriteEndpoint, getAppwriteProjectId } from '../_lib/appwrite.js';
import { parseEmailAddress } from '../_lib/email.js';
import { bodyFields } from '../_lib/http.js';
import { consumeVerificationRequestQuota } from '../_lib/verificationStore.js';

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

/** Clé du quota maison des demandes de récupération d'une adresse (verificationStore). */
function recoveryQuotaKey(email: string): string {
  return `recovery:${email}`;
}

/**
 * Quota par adresse (30 s entre deux demandes, 5 par heure, comme les codes) :
 * la récupération part avec la clé d'API, donc sans la limite anti-abus
 * d'Appwrite. Faux = demande à ignorer en silence (la réponse reste neutre).
 */
function consumeRecoveryQuota(email: string): boolean {
  try {
    consumeVerificationRequestQuota(recoveryQuotaKey(email));
    return true;
  } catch {
    return false;
  }
}

function recoveryRequest(email: string, redirectUrl: string, withKey: boolean): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Appwrite-Project': getAppwriteProjectId(),
  };
  const apiKey = process.env.APPWRITE_API_KEY;
  if (withKey && apiKey) headers['X-Appwrite-Key'] = apiKey;
  return fetch(`${getAppwriteEndpoint()}/account/recovery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, url: redirectUrl }),
    signal: AbortSignal.timeout(RECOVERY_TIMEOUT_MS),
  });
}

/**
 * Demande à Appwrite l'e-mail de récupération, **avec la clé d'API** (portée
 * `sessions.write`) : sans elle, Appwrite limite la route à 10 demandes par
 * heure et par IP, et l'IP qu'il voit est celle du serveur de l'app — un seul
 * compteur pour tout le service, que n'importe qui pouvait épuiser (A1-1).
 * Une requête à clé saute cette limite (`shared/api.php`, `isKey`) ; notre
 * quota par adresse la remplace. Une clé sans la portée (401) est signalée et
 * la demande repart sans clé, pour ne jamais rien perdre.
 *
 * Une adresse sans compte répond 404 (Appwrite 1.6) ou 201 sans e-mail
 * (2.x) : attendu, silencieux. Tout autre échec, 429 compris (plus aucun
 * n'est attendu), est journalisé et part à GlitchTip : personne ne reçoit
 * plus de lien sans que rien ne le dise.
 */
async function dispatchRecovery(email: string, redirectUrl: string, requestId?: string): Promise<void> {
  try {
    let response = await recoveryRequest(email, redirectUrl, true);
    if (response.status === 401 && process.env.APPWRITE_API_KEY) {
      const detail = await response.text().catch(() => '');
      captureServerError(
        new Error(`Appwrite recovery refused the API key (scope sessions.write missing?): ${detail.slice(0, 120)}`),
        { route: 'auth/forgot-password', requestId },
      );
      response = await recoveryRequest(email, redirectUrl, false);
    }
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '');
      console.error(`[forgot-password] Appwrite recovery HTTP ${response.status}:`, detail.slice(0, 200));
      captureServerError(new Error(`Appwrite recovery HTTP ${response.status}`), { route: 'auth/forgot-password', requestId });
    }
  } catch (error) {
    console.error('[forgot-password] Appwrite recovery request failed:', error);
    captureServerError(error, { route: 'auth/forgot-password', requestId });
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
  // Au-delà du quota de l'adresse, rien ne part, et la réponse ne le dit pas.
  if (consumeRecoveryQuota(trimmedEmail)) {
    void dispatchRecovery(trimmedEmail, resolveRedirectUrl(redirectUrl), req.requestId);
  }
  await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));

  // Anti-énumération : même réponse dans tous les cas.
  return res.status(200).json({ success: true, message: NEUTRAL_SUCCESS_MESSAGE });
}
