/**
 * Nom affiché pour l'auteur d'un commentaire.
 *
 * `authorName` est écrit par le client de l'auteur : dans un projet partagé,
 * seul le nom tiré de la liste des membres fait foi. Un auteur qui n'en fait
 * plus partie (retiré, parti, compte supprimé) s'affichait sous le nom qu'il
 * s'était choisi (« Victor (propriétaire) »…) : il devient « Ancien éditeur »
 * (A7-1). Hors projet partagé (commentaires venus d'un fichier importé), le
 * nom enregistré reste affiché.
 */
import { translateAppText } from '@/shared/i18n/config';

import type { MentionCandidate } from './messageText';

/**
 * État de la liste des membres : `undefined` = projet non partagé ;
 * `loading` = projet partagé, liste pas encore lue ; `ready` = liste lue.
 */
export type CommentMembersStatus = 'loading' | 'ready' | undefined;

export function commentAuthorLabel(
  userId: string,
  storedName: string | undefined,
  members: readonly MentionCandidate[],
  membersStatus: CommentMembersStatus,
): string {
  const member = members.find((candidate) => candidate.userId === userId);
  if (member) return member.name;
  if (membersStatus === 'ready') return translateAppText('Ancien éditeur');
  if (membersStatus === 'loading') return translateAppText('Éditeur');
  return storedName || translateAppText('Éditeur');
}
