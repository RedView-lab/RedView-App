import { trackAnalyticsEvent } from '@/shared/lib/analytics';

import type { CommentAction } from './commentActions';

/**
 * Mesure d'audience des commentaires, au seul point d'écriture (le réducteur
 * appliqué par CommentToolContext, pour la carte comme pour le viewer LiDAR) :
 * la sorte d'action et la surface, jamais le texte ni l'auteur.
 */
export function trackCommentAction(action: CommentAction, surface: 'map' | 'lidar'): void {
  switch (action.type) {
    case 'create-thread':
      trackAnalyticsEvent({ name: 'comment_created', data: { anchor: action.zone ? 'zone' : 'point', on: surface } });
      return;
    case 'reply':
      trackAnalyticsEvent({ name: 'comment_replied', data: { on: surface } });
      return;
    case 'set-resolved':
      if (action.resolved) trackAnalyticsEvent({ name: 'comment_resolved', data: { on: surface } });
      return;
    default:
      return;
  }
}
