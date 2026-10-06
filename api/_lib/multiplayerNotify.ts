import { createHmac } from 'node:crypto';

/**
 * Prévient le serveur temps réel que les accès d'un projet ont changé
 * (éditeur retiré, départ, projet supprimé) : il revérifie tout de suite les
 * éditeurs connectés à la salle au lieu d'attendre sa revérification
 * périodique (server/multiplayer/server.ts, `POST /internal/access-changed`).
 *
 * Message signé (HMAC-SHA256 du corps avec `MULTIPLAYER_INTERNAL_SECRET`,
 * horodaté) ; sans secret ou sans `MULTIPLAYER_INTERNAL_URL`, rien n'est
 * envoyé. Jamais bloquant : un échec laisse la revérification périodique
 * fermer la connexion.
 */
const NOTIFY_TIMEOUT_MS = 2_000;

export async function notifyProjectAccessChanged(projectId: string): Promise<void> {
  const secret = process.env.MULTIPLAYER_INTERNAL_SECRET;
  const base = process.env.MULTIPLAYER_INTERNAL_URL;
  if (!secret || !base) return;
  const body = JSON.stringify({ projectId, ts: Date.now() });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  try {
    const response = await fetch(`${base.replace(/\/+$/, '')}/internal/access-changed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-redview-signature': signature },
      body,
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!response.ok) console.warn('[projects/share] serveur temps réel non prévenu', response.status);
  } catch (error) {
    console.warn('[projects/share] serveur temps réel injoignable', error);
  }
}
