import { translateAppText } from '@/shared/i18n';

/**
 * `fetch` vers l'API de l'app (/api/*) depuis un écran qui attend la réponse
 * (bouton en cours, pop-in) : un réseau qui pend (Wi-Fi captif, mobile en
 * zone blanche) ne laisse jamais le bouton tourner indéfiniment, et une panne
 * réseau devient un message lisible au lieu du « Failed to fetch » du
 * navigateur.
 *
 * Le délai court jusqu'aux en-têtes de la réponse (le corps des réponses de
 * l'API est petit). Une écriture qui dépasse le délai a pu aboutir côté
 * serveur : les routes appelées ainsi sont idempotentes ou relues ensuite.
 */

export class ApiNetworkError extends Error {
  readonly timedOut: boolean;

  constructor(timedOut: boolean, options?: { cause?: unknown }) {
    super(
      translateAppText(
        timedOut
          ? "Le serveur RedView n'a pas répondu à temps. Vérifiez votre connexion puis réessayez."
          : 'Impossible de joindre le serveur RedView. Vérifiez votre connexion puis réessayez.',
      ),
      options,
    );
    this.name = 'ApiNetworkError';
    this.timedOut = timedOut;
  }
}

export async function apiFetch(input: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, signal: callerSignal, ...rest } = init;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // `AbortSignal.any` manque avant Safari 17.4 : relais à la main.
  const relayAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) relayAbort();
  else callerSignal?.addEventListener('abort', relayAbort, { once: true });
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } catch (error) {
    // Annulation voulue par l'appelant : elle reste une AbortError.
    if (callerSignal?.aborted) throw error;
    throw new ApiNetworkError(timedOut, { cause: error });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', relayAbort);
  }
}

/**
 * Délai pour un appel qui n'est pas un `fetch` à nous (SDK Appwrite : il n'a
 * pas d'option de délai). La requête continue en arrière-plan ; l'écran, lui,
 * reçoit une `ApiNetworkError(timedOut)` lisible au lieu d'attendre sans fin.
 */
export function withNetworkTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiNetworkError(true)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
