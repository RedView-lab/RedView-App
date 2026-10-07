import { captureServerError } from '../../server/lib/observability.mjs';
import type { ApiResponse } from './types.js';

/**
 * Erreur dont le message est volontairement destiné à l'utilisateur final
 * (validation, quota, ressource introuvable…). Tout autre `Error` est
 * considéré comme interne : son message n'est jamais renvoyé au client.
 */
export class PublicError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
  }
}

/**
 * Répond à une erreur sans rien fuiter d'interne :
 *  - `PublicError` : son statut et son message (refus attendu : une ligne
 *    d'avertissement, une erreur seulement à partir de 500) ;
 *  - toute autre erreur : `500` + `fallbackMessage`, l'erreur complète dans
 *    les logs et dans GlitchTip (une erreur rattrapée ici ne remonterait
 *    sinon jamais : server.mjs ne capture que ce qu'un handler laisse passer).
 */
export function sendSafeError(
  res: ApiResponse,
  err: unknown,
  fallbackMessage: string,
  logTag: string,
): ApiResponse {
  if (err instanceof PublicError) {
    if (err.status >= 500) console.error(`[${logTag}] ${err.status}:`, err);
    else console.warn(`[${logTag}] ${err.status}: ${err.message}`);
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`[${logTag}] Error:`, err);
  captureServerError(err, { route: logTag });
  return res.status(500).json({ error: fallbackMessage });
}
