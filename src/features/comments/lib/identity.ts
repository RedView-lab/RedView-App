import { DEV_USER_ID, devTabUserId } from '@/features/collab/hooks/useCollabSession';
import { translateAppText } from '@/shared/i18n';
import { getSessionUserIdSync, readStoredAppwriteSession } from '@/shared/services/appwrite';

import type { CommentAuthor } from './commentActions';
import type { MentionCandidate } from './messageText';

/**
 * Auteur des commentaires : l'utilisateur de la session Appwrite (le même id
 * que celui que voit le serveur temps réel). Sans session (compte démo en
 * développement), l'utilisateur des jetons de dev (`?devUser=<id>` : celui de
 * l'onglet).
 */
export function readCommentAuthor(): CommentAuthor {
  const sessionUserId = getSessionUserIdSync();
  const devUser = sessionUserId ? null : devTabUserId();
  if (devUser) return { userId: devUser, name: devUser };
  const user = readStoredAppwriteSession()?.user;
  return {
    userId: sessionUserId ?? DEV_USER_ID,
    name: user?.name?.trim() || user?.email?.trim() || translateAppText('Moi'),
  };
}

/** Membres connus (partage, présence), dédoublonnés ; le premier nom non vide l'emporte. */
export function mergeMentionCandidates(...lists: ReadonlyArray<readonly MentionCandidate[] | undefined>): MentionCandidate[] {
  const byUser = new Map<string, MentionCandidate>();
  for (const list of lists) {
    for (const candidate of list ?? []) {
      const name = candidate.name.trim();
      if (!candidate.userId || !name || byUser.has(candidate.userId)) continue;
      byUser.set(candidate.userId, { userId: candidate.userId, name });
    }
  }
  return [...byUser.values()];
}
