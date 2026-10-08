import { useEffect } from 'react';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import { isFreeCamActive } from '@/features/freeCam';

export interface UseItineraryUndoRedoShortcutArgs {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  enabled?: boolean;
}

/**
 * Raccourci clavier global pour Annuler (Ctrl+Z / Cmd+Z) et Rétablir (Ctrl+Y / Cmd+Y / Ctrl+Maj+Z / Cmd+Maj+Z).
 *
 * Respecte les champs input/textarea/contentEditable pour ne pas détourner l'édition de texte native.
 */
export function useItineraryUndoRedoShortcut({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  enabled = true,
}: UseItineraryUndoRedoShortcutArgs): void {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ne jamais détourner la saisie de texte (champs de recherche, édition du titre, notes, etc.)
      if (isTypingTarget(event.target)) return;
      // Cmd/Ctrl servent à descendre en FreeCam : Cmd/Ctrl+Z (avancer) ne doit pas annuler.
      if (isFreeCamActive()) return;

      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const isCmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
      if (!isCmdOrCtrl) return;

      const key = event.key.toLowerCase();

      // Annuler : Ctrl+Z / Cmd+Z (sans Maj ni Alt)
      if (key === 'z' && !event.shiftKey && !event.altKey) {
        if (!canUndo) return;
        event.preventDefault();
        event.stopPropagation();
        onUndo();
        return;
      }

      // Rétablir : Ctrl+Y / Cmd+Y OU Ctrl+Maj+Z / Cmd+Maj+Z
      if (
        ((key === 'y' && !event.shiftKey) || (key === 'z' && event.shiftKey)) &&
        !event.altKey
      ) {
        if (!canRedo) return;
        event.preventDefault();
        event.stopPropagation();
        onRedo();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [canRedo, canUndo, enabled, onRedo, onUndo]);
}
