import { useEffect, useRef } from 'react';

import { getCameraOwner } from '@/features/map3d/lib/cameraOwnership';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';

import { useCommentToolOptional } from '../context/commentTool';

/**
 * Raccourcis des commentaires (ceux de Figma) : C = mode commentaire,
 * Maj+C = afficher / masquer les bulles, Échap = annuler la saisie, fermer le
 * fil ouvert, puis quitter le mode. Jamais pendant une saisie de texte ni le
 * flyover. `onBeforeArm` désarme les autres outils de la carte.
 */
export function CommentShortcuts({ onBeforeArm }: { onBeforeArm(): void }) {
  const tool = useCommentToolOptional();
  const latest = useRef({ tool, onBeforeArm });
  useEffect(() => {
    latest.current = { tool, onBeforeArm };
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const current = latest.current.tool;
      if (!current || event.defaultPrevented || isTypingTarget(event.target) || getCameraOwner()) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        if (current.draft) current.cancelDraft();
        else if (current.openThreadId) current.closeThread();
        else if (current.armed) current.deactivate();
        else return;
        event.preventDefault();
        return;
      }
      if (event.key.toLowerCase() !== 'c' || event.repeat) return;
      event.preventDefault();
      if (event.shiftKey) {
        current.togglePinsHidden();
        return;
      }
      if (!current.armed) latest.current.onBeforeArm();
      current.toggle();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return null;
}
