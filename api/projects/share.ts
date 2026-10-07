import type { ApiRequest, ApiResponse } from '../_lib/types.js';

import { createRateLimiter, getClientIp, rateLimitKeyForIp } from '../../server/lib/http-security.mjs';
import { requireAuthenticatedUser } from '../_lib/appwrite.js';
import { PublicError, sendSafeError } from '../_lib/errors.js';
import { readJsonBody, sendMethodNotAllowed } from '../_lib/http.js';
import {
  assertProjectId,
  deleteSharedProject,
  getShareState,
  inviteToProject,
  leaveProject,
  removeFromProject,
} from '../_lib/projectSharing.js';

/**
 * Partage d'un projet (co-édition) — POST JSON `{ action, projectId, … }` :
 *  - `list` : membres (propriétaire ou éditeur) ;
 *  - `invite` `{ email }` : ajoute un compte RedView existant comme éditeur
 *    (propriétaire seulement) ;
 *  - `remove` `{ userId }` : retire un éditeur (propriétaire seulement) ;
 *  - `leave` : un éditeur quitte le projet ;
 *  - `delete` : le propriétaire supprime le projet partagé (avec l'équipe et
 *    les données de la co-édition, que seule la clé admin peut effacer).
 */
interface ShareBody {
  action?: unknown;
  projectId?: unknown;
  email?: unknown;
  userId?: unknown;
}

/** Invitations par IP (en plus de la limite par compte de projectSharing.ts) : plusieurs comptes d'une même machine. */
const MAX_INVITES_PER_IP = 40;
const inviteIpLimiter = createRateLimiter({ windowMs: 10 * 60_000, maxKeys: 20_000 });

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return sendMethodNotAllowed(res, ['POST']);
  try {
    const user = await requireAuthenticatedUser(req, res);
    if (!user) return;
    const body = await readJsonBody<ShareBody>(req);
    const projectId = assertProjectId(body.projectId);
    switch (body.action) {
      case 'list':
        return res.status(200).json(await getShareState(user, projectId));
      case 'invite':
        if (!inviteIpLimiter(rateLimitKeyForIp(getClientIp(req)), MAX_INVITES_PER_IP)) {
          throw new PublicError('Too many invitations, try again later', 429);
        }
        return res.status(200).json(await inviteToProject(user, projectId, body.email));
      case 'remove':
        return res.status(200).json(await removeFromProject(user, projectId, body.userId));
      case 'leave':
        await leaveProject(user, projectId);
        return res.status(200).json({ ok: true });
      case 'delete':
        await deleteSharedProject(user, projectId);
        return res.status(200).json({ ok: true });
      default:
        throw new PublicError('Unknown action', 400);
    }
  } catch (error) {
    return sendSafeError(res, error, 'Unable to update project sharing', 'projects/share');
  }
}
