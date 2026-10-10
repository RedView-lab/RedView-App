import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { captureServerError } from '../../server/lib/observability.mjs';
import { beginAccountDeletion, deleteAccount, listStalePendingDeletions } from '../_lib/accountDeletion.js';
import { getAppwriteUsers, requireAuthenticatedUser } from '../_lib/appwrite.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import { sendAccountDeletedEmail } from '../_lib/mailer.js';
import {
  accountDeletionCodeKey,
  consumeVerificationRequestQuota,
  releaseVerificationRequest,
  requestAccountDeletionCode,
  validateVerificationCode,
} from '../_lib/verificationStore.js';

/**
 * Suppression du compte connecté (RGPD, art. 17) — POST JSON `{ action, … }` :
 *  - `request-code` : envoie un code à 6 chiffres à l'adresse du compte ;
 *  - `confirm` `{ code, confirm: 'delete-my-account' }` : vérifie le code,
 *    bloque le compte et inscrit la suppression au registre, répond 202, puis
 *    supprime toutes ses données en tâche de fond (api/_lib/accountDeletion.ts)
 *    et envoie un accusé de suppression.
 *
 * Le code prouve l'accès à la boîte du compte : une session volée (onglet
 * resté ouvert, jeton dérobé) ne suffit pas à tout effacer. Il marche aussi
 * pour les comptes Google, qui n'ont pas de mot de passe. Codes et quotas sont
 * ceux de l'inscription (10 min, 5 essais, verrou 24 h après 10 échecs), sous
 * une clé à part. Sous `auth/`, la route a le quota strict de server.mjs.
 */
interface DeleteAccountBody {
  action?: unknown;
  code?: unknown;
  confirm?: unknown;
}

const CONFIRMATION = 'delete-my-account';
const CODE_PATTERN = /^\d{6}$/;
/** Reprises d'une purge interrompue, dans ce processus ; ensuite scripts/appwrite/account-deletions.ts --resume. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
/** Âge à partir duquel une suppression en attente est reprise au démarrage du serveur (après les reprises ci-dessus). */
const RESUME_PENDING_AFTER_MS = 15 * 60_000;
/** Purges en cours dans ce processus : la reprise ne les double pas. */
const inFlight = new Set<string>();
/**
 * Reprises automatiques ratées par compte, dans ce processus. Un échec durable
 * (refus de Stripe, droit manquant à la clé) n'est plus repris au-delà : il
 * resterait relancé et signalé toutes les 15 min. Le compte reste `pending` au
 * registre pour le script d'admin. Compté en mémoire, pas au registre : pas
 * d'attribut de plus au schéma de production.
 */
const resumeFailures = new Map<string, number>();
const MAX_RESUME_FAILURES = 5;

/**
 * Purge complète après la réponse (A14-1) : elle parcourt les trois buckets et
 * chaque projet possédé, ce qui dépasserait le délai du nginx de l'hôte (60 s)
 * sur un gros compte. L'accusé part quand elle est finie.
 */
function purgeInBackground(userId: string, email: string | null, name: string, attempt = 0): void {
  inFlight.add(userId);
  deleteAccount(userId).then(
    // Sans bloquer : le compte est supprimé même si l'accusé ne part pas.
    () => {
      inFlight.delete(userId);
      resumeFailures.delete(userId);
      if (email) void sendAccountDeletedEmail({ to: email, name });
    },
    (error: unknown) => {
      if (attempt >= RETRY_DELAYS_MS.length) {
        // Reprises de la requête épuisées, ou passage de resumePendingAccountDeletions :
        // la suite revient aux passages périodiques. Premier échec et abandon
        // signalés, pas chaque passage.
        inFlight.delete(userId);
        const failures = (resumeFailures.get(userId) ?? 0) + 1;
        resumeFailures.set(userId, failures);
        const givingUp = failures >= MAX_RESUME_FAILURES;
        console.error(
          givingUp
            ? '[auth/delete-account] reprise automatique abandonnée : scripts/appwrite/account-deletions.ts --resume'
            : '[auth/delete-account] reprise automatique ratée',
          userId,
          failures,
          error,
        );
        if (failures === 1 || givingUp) captureServerError(error, { route: 'auth/delete-account' });
        return;
      }
      console.error('[auth/delete-account] purge interrompue, reprise programmée', userId, error);
      captureServerError(error, { route: 'auth/delete-account' });
      finishDeletionLater(userId, email, name, attempt);
    },
  );
}

function finishDeletionLater(userId: string, email: string | null, name: string, attempt = 0): void {
  const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  const timer = setTimeout(() => purgeInBackground(userId, email, name, attempt + 1), delay);
  timer.unref?.();
}

/**
 * Reprend les suppressions restées en attente (registre `pending` depuis plus
 * de 15 min) : une purge de fond coupée par un redéploiement n'est reprise par
 * rien d'autre que le script d'admin. Lancée par server.mjs dans l'image de
 * production seulement (server/lib/account-deletion-resume.mjs). L'accusé
 * part à l'adresse du compte, encore lisible tant qu'il est seulement bloqué.
 * Rend les comptes repris.
 */
export async function resumePendingAccountDeletions(now = Date.now()): Promise<string[]> {
  const pending = (await listStalePendingDeletions(now, RESUME_PENDING_AFTER_MS))
    .filter((userId) => !inFlight.has(userId) && (resumeFailures.get(userId) ?? 0) < MAX_RESUME_FAILURES);
  for (const userId of pending) {
    let profile: { email?: string; name?: string } | null = null;
    try {
      profile = await getAppwriteUsers().get(userId);
    } catch (error) {
      // Compte déjà supprimé : la purge ne fait que compléter le registre, sans accusé.
      if ((error as { code?: unknown } | null)?.code !== 404) throw error;
    }
    purgeInBackground(userId, profile?.email || null, profile?.name ?? '', RETRY_DELAYS_MS.length);
  }
  if (pending.length > 0) console.log('[auth/delete-account] suppressions en attente reprises', pending);
  return pending;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    if (!user.email) throw new PublicError('This account has no email address: contact support to delete it', 400);
    const body = await readJsonBody<DeleteAccountBody>(req);
    const key = accountDeletionCodeKey(user.email);

    switch (body.action) {
      case 'request-code': {
        consumeVerificationRequestQuota(key);
        let sent = false;
        try {
          const profile = await getAppwriteUsers().get(user.id);
          ({ sent } = await requestAccountDeletionCode(user.email, profile.name));
        } finally {
          // Rien n'est parti (Appwrite ou e-mail en échec) : la demande n'est
          // pas décomptée, le nouvel essai n'attend pas 30 s.
          if (!sent) releaseVerificationRequest(key);
        }
        if (!sent) throw new PublicError('The confirmation email could not be sent, try again later', 503);
        return res.status(200).json({ sent: true });
      }
      case 'confirm': {
        if (body.confirm !== CONFIRMATION) throw new PublicError('Missing confirmation', 400);
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!CODE_PATTERN.test(code)) throw new PublicError('The code has 6 digits', 400);
        const validation = validateVerificationCode(key, code);
        if (!validation.valid) throw new PublicError(validation.error || 'Invalid code', validation.status ?? 400);
        const profile = await getAppwriteUsers().get(user.id);
        // Bloqué et inscrit au registre avant de répondre : plus aucune session
        // ne peut écrire, et une panne du processus est reprise par le script
        // d'admin. Une erreur ici laisse le compte intact : la personne réessaie.
        await beginAccountDeletion(user.id);
        purgeInBackground(user.id, user.email, profile.name);
        return res.status(202).json({ deleted: false, pending: true });
      }
      default:
        throw new PublicError('Unknown action', 400);
    }
  } catch (error) {
    return sendSafeError(res, error, 'Unable to delete the account', 'auth/delete-account');
  }
}
