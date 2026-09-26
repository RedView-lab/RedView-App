import { useEffect } from 'react';

export interface UseItineraryUndoRedoShortcutArgs {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  enabled?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * Global keyboard accelerator for Undo (Ctrl+Z / Cmd+Z) and Redo (Ctrl+Y / Cmd+Y / Ctrl+Shift+Z / Cmd+Shift+Z).
 *
 * Respects text inputs/textareas/contentEditable to avoid hijacking native text editing.
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
      // Never hijack text typing (search inputs, title edit, notes, etc.)
      if (isTypingTarget(event.target)) return;

      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const isCmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
      if (!isCmdOrCtrl) return;

      const key = event.key.toLowerCase();

      // Undo: Ctrl+Z / Cmd+Z (without Shift or Alt)
      if (key === 'z' && !event.shiftKey && !event.altKey) {
        if (!canUndo) return;
        event.preventDefault();
        event.stopPropagation();
        onUndo();
        return;
      }

      // Redo: Ctrl+Y / Cmd+Y OR Ctrl+Shift+Z / Cmd+Shift+Z
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
