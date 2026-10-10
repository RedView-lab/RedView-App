import type { MutableRefObject } from 'react';

import type { ProjectCommentThread } from '@/features/itineraryPanel/types';

/**
 * Réponses en cours de saisie, par fil, gardées hors de la carte du fil : elle
 * se ferme quand le fil disparaît, son texte non (E3-1). Rouvrir un fil
 * retrouve aussi sa réponse commencée.
 */
export class ReplyDrafts {
  private readonly texts = new Map<string, string>();

  text(threadId: string): string {
    return this.texts.get(threadId) ?? '';
  }

  /** Lien pour `CommentComposer.textRef` : chaque frappe y est écrite. */
  binding(threadId: string): MutableRefObject<string> {
    const texts = this.texts;
    return {
      get current() {
        return texts.get(threadId) ?? '';
      },
      set current(value: string) {
        if (value) texts.set(threadId, value);
        else texts.delete(threadId);
      },
    };
  }

  /** Texte du fil, retiré. */
  take(threadId: string): string {
    const text = this.text(threadId);
    this.texts.delete(threadId);
    return text;
  }
}

/**
 * Réponse restée sans fil : le fil ouvert (`previous`) a disparu du projet
 * pendant qu'on y écrivait `text` — supprimé par son auteur, un autre éditeur
 * (supprimer son propre fil est voulu). Renvoie le texte à garder, sinon null
 * (E3-1).
 */
export function orphanedReply(
  previous: ProjectCommentThread | null,
  openNow: ProjectCommentThread | null,
  threads: readonly ProjectCommentThread[],
  myUserId: string,
  text: string | undefined,
): string | null {
  if (!previous || openNow) return null;
  if (threads.some((thread) => thread.id === previous.id)) return null;
  if (previous.createdBy === myUserId) return null;
  const kept = text?.trim();
  return kept ? kept : null;
}
