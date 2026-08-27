import { useEffect } from 'react';

/**
 * Keyboard accelerators that act on the currently active itinerary.
 *
 * Listens at the window level so the shortcut works regardless of focus —
 * whether the user has just clicked an itinerary tab in the left panel, or a
 * row in the central synthesis panel. The active itinerary is the single
 * source of truth shared by both panels, so deleting it is consistent from
 * either surface.
 *
 * Guards:
 *  - ignores key presses while typing in inputs / textareas / contentEditable
 *    fields (so editing an itinerary name, a search box, etc. never triggers a
 *    deletion);
 *  - ignores presses that include modifier keys (so OS / browser combos such
 *    as Shift+Delete or Ctrl+Shift+Delete keep their native behavior);
 *  - no-ops when there is nothing to delete, or only a single itinerary
 *    remains (matching the `removeItinerary` store rule).
 */
export interface UseItineraryDeleteShortcutArgs {
  /** Currently active itinerary, or null when none is selected. */
  activeItineraryId: string | null;
  /** Total number of itineraries; deletion is disabled when ≤ 1. */
  itineraryCount: number;
  /** Removes the itinerary with the given id. Returns true if it was removed. */
  onRemove: (id: string) => boolean;
  /** When false, the listener is detached entirely. */
  enabled?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useItineraryDeleteShortcut({
  activeItineraryId,
  itineraryCount,
  onRemove,
  enabled = true,
}: UseItineraryDeleteShortcutArgs): void {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Only react to the bare Delete / Backspace keys. Any held modifier
      // (Ctrl, Alt, Shift, Meta) defers to the browser / OS.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;

      // Never hijack text entry.
      if (isTypingTarget(event.target)) return;

      if (!activeItineraryId || itineraryCount <= 0) return;

      const removed = onRemove(activeItineraryId);
      if (removed) {
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeItineraryId, itineraryCount, onRemove, enabled]);
}
