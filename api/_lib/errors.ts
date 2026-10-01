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
 * Logue l'erreur complète côté serveur et ne renvoie au client que :
 *  - `err.status` / `err.message` si c'est une `PublicError`,
 *  - sinon `500` + `fallbackMessage` (aucune fuite de détail interne).
 */
export function sendSafeError(
  res: ApiResponse,
  err: unknown,
  fallbackMessage: string,
  logTag: string,
): ApiResponse {
  console.error(`[${logTag}] Error:`, err);
  if (err instanceof PublicError) {
    return res.status(err.status).json({ error: err.message });
  }
  return res.status(500).json({ error: fallbackMessage });
}
