import { Account, Client, Query } from 'node-appwrite';

import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { captureServerError } from '../../server/lib/observability.mjs';
import { getAppwriteEndpoint, getAppwriteProjectId, getAppwriteUsers, requireAuthenticatedUser } from '../_lib/appwrite.js';
import { getCustomerRow } from '../_lib/billing/customers.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { sendEmailChangedNoticeEmail, sendEmailChangeTakenEmail } from '../_lib/mailer.js';
import { getStripeServer } from '../_lib/stripe.js';
import {
  checkVerificationCode,
  consumeVerificationCode,
  consumeVerificationRequestQuota,
  emailChangeCodeKey,
  normalizeVerificationEmail,
  recordVerificationFailure,
  releaseVerificationRequest,
  requestEmailChangeCode,
} from '../_lib/verificationStore.js';

/**
 * Changement de l'adresse e-mail du compte connecté — POST JSON `{ action, … }` :
 *  - `request-code` `{ newEmail }` : envoie un code à 6 chiffres à la nouvelle
 *    adresse (preuve qu'elle appartient à la personne) ;
 *  - `confirm` `{ newEmail, code, password }` : vérifie le code (lié à cette
 *    adresse), puis change l'adresse avec la session de l'utilisateur et son
 *    mot de passe — Appwrite le vérifie lui-même : une session volée ne
 *    suffit pas à prendre le compte —, la garde vérifiée (le partage exige un
 *    compte vérifié), met à jour le client Stripe et prévient l'ancienne
 *    adresse.
 *
 * Un compte sans mot de passe (Google) en définit un d'abord (Compte → Mot de
 * passe). Demandes et échecs (codes et mots de passe) sont comptés par compte
 * (`emailChangeCodeKey`), avec les règles de l'inscription (10 min, 5 essais,
 * verrou 24 h après 10 échecs). Sous `auth/` : le quota strict de server.mjs.
 */
interface ChangeEmailBody {
  action?: unknown;
  newEmail?: unknown;
  code?: unknown;
  password?: unknown;
}

const CODE_PATTERN = /^\d{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

const NO_PASSWORD_MESSAGE =
  'Définissez d’abord un mot de passe (section Mot de passe ci-dessous) pour pouvoir changer d’adresse.';
const EMAIL_TAKEN_MESSAGE = 'Cette adresse est déjà utilisée par un autre compte.';

function readNewEmail(body: ChangeEmailBody, currentEmail: string | null): string {
  const raw = typeof body.newEmail === 'string' ? body.newEmail : '';
  const email = normalizeVerificationEmail(raw);
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new PublicError('Adresse e-mail invalide.', 400);
  }
  if (currentEmail && email === normalizeVerificationEmail(currentEmail)) {
    throw new PublicError('C’est déjà l’adresse de votre compte.', 400);
  }
  return email;
}

function appwriteType(error: unknown): string | null {
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : null;
}

function bearerToken(req: ApiRequest): string {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new PublicError('Authentication required', 401);
  return token;
}

/** Reçus et factures Stripe : suivent l'adresse du compte, sauf adresse de facturation choisie à part. */
async function syncStripeCustomerEmail(userId: string, email: string, requestId?: string): Promise<void> {
  try {
    const row = await getCustomerRow(userId);
    if (!row?.stripe_customer_id || row.billing_email_mode === 'alternative') return;
    await getStripeServer().customers.update(row.stripe_customer_id, { email });
  } catch (error) {
    // L'adresse du compte a changé : Stripe se rattrape à la prochaine vue de
    // l'abonnement ; on le signale sans faire échouer la demande.
    captureServerError(error, { route: 'auth/change-email', requestId });
  }
}

/** Marque l'adresse vérifiée, un nouvel essai compris ; un échec est signalé sans interrompre le changement. */
async function markEmailVerified(userId: string, requestId?: string): Promise<void> {
  const users = getAppwriteUsers();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await users.updateEmailVerification(userId, true);
      return;
    } catch (error) {
      if (attempt === 1) {
        console.error('[change-email] Email changed but verification flag not set:', error);
        captureServerError(error, { route: 'auth/change-email', requestId });
      }
    }
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const body = await readJsonBody<ChangeEmailBody>(req);
    const key = emailChangeCodeKey(user.id);
    const newEmail = readNewEmail(body, user.email);
    const users = getAppwriteUsers();
    const profile = await users.get(user.id);
    if (!profile.passwordUpdate) throw new PublicError(NO_PASSWORD_MESSAGE, 400);

    switch (body.action) {
      case 'request-code': {
        // Quota d'abord : la vérification « adresse déjà prise » ne sert pas
        // à sonder des adresses sans limite.
        consumeVerificationRequestQuota(key);
        // Adresse déjà prise : même réponse qu'un envoi de code (un 409 ici
        // disait à tout compte connecté si une adresse a un compte RedView,
        // A1-3) ; le propriétaire de la boîte est prévenu à la place.
        const taken = await users.list([Query.equal('email', newEmail), Query.limit(1)]);
        const { sent } = taken.total > 0
          ? await sendEmailChangeTakenEmail({ to: newEmail })
          : await requestEmailChangeCode(user.id, newEmail);
        if (!sent) {
          // Rien n'est parti : la demande n'est pas décomptée, le nouvel essai
          // n'attend pas 30 s.
          releaseVerificationRequest(key);
          throw new PublicError('L’e-mail de confirmation n’a pas pu partir. Réessayez plus tard.', 503);
        }
        return res.status(200).json({ sent: true });
      }
      case 'confirm': {
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!CODE_PATTERN.test(code)) throw new PublicError('Le code comporte 6 chiffres.', 400);
        const password = typeof body.password === 'string' ? body.password : '';
        if (password.length < 8 || password.length > 256) throw new PublicError('Mot de passe actuel incorrect.', 400);

        // Code vérifié sans être consommé : un mot de passe faux ou une
        // adresse prise entre-temps laissent un nouvel essai possible.
        const check = checkVerificationCode(key, code, newEmail);
        if (!check.valid) throw new PublicError(check.error || 'Code invalide.', check.status ?? 400);

        const userAccount = new Account(
          new Client().setEndpoint(getAppwriteEndpoint()).setProject(getAppwriteProjectId()).setJWT(bearerToken(req)),
        );
        try {
          await userAccount.updateEmail(newEmail, password);
        } catch (error) {
          const type = appwriteType(error);
          if (type === 'user_invalid_credentials') {
            // Compté comme un mauvais code : pas de force brute du mot de passe par cette route.
            recordVerificationFailure(key);
            throw new PublicError('Mot de passe actuel incorrect.', 400);
          }
          if (type === 'user_email_already_exists' || type === 'user_already_exists') {
            throw new PublicError(EMAIL_TAKEN_MESSAGE, 409);
          }
          throw error;
        }
        consumeVerificationCode(key);

        // Appwrite marque la nouvelle adresse non vérifiée : le code vient de
        // prouver le contraire. L'adresse a déjà changé et le code est
        // consommé : un échec ici ne doit pas faire répondre « échec » (A1-2),
        // sinon le nouvel essai tombe sur « c'est déjà votre adresse » et
        // Stripe / l'avis à l'ancienne adresse sont sautés.
        await markEmailVerified(user.id, req.requestId);
        await syncStripeCustomerEmail(user.id, newEmail, req.requestId);
        if (user.email) void sendEmailChangedNoticeEmail({ to: user.email, name: profile.name, newEmail });
        return res.status(200).json({ email: newEmail });
      }
      default:
        throw new PublicError('Unknown action', 400);
    }
  } catch (error) {
    return sendSafeError(res, error, 'Impossible de changer l’adresse e-mail.', 'auth/change-email');
  }
}
