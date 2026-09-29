import { useEffect, useRef, type RefObject } from 'react';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import { isEscapeKey, isFreeCamToggleKey, resolveFreeCamAction } from '../lib/keyBindings';
import { resetInputState, type FreeCamInputState } from '../lib/inputState';

interface UseFreeCamKeyboardArgs {
  enabled: boolean;
  activeRef: RefObject<boolean>;
  input: FreeCamInputState;
  onToggle: () => void;
  onEscape: () => void;
}

/**
 * Clavier FreeCam, écouté sur `window` en capture pour passer avant les
 * raccourcis de l'app : F active/quitte ; en vol, les touches de mouvement
 * sont consommées (pas de Ctrl+Z / Ctrl+S / Ctrl+D navigateur ou app).
 */
export function useFreeCamKeyboard({ enabled, activeRef, input, onToggle, onEscape }: UseFreeCamKeyboardArgs): void {
  const onToggleRef = useRef(onToggle);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onToggleRef.current = onToggle;
    onEscapeRef.current = onEscape;
  }, [onToggle, onEscape]);

  useEffect(() => {
    if (!enabled) return;

    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const active = activeRef.current;
      if (!active && isTypingTarget(event.target)) return;

      if (isFreeCamToggleKey(event)) {
        consume(event);
        onToggleRef.current();
        return;
      }

      if (!active) return;

      if (isEscapeKey(event)) {
        consume(event);
        onEscapeRef.current();
        return;
      }

      const action = resolveFreeCamAction(event);
      if (!action) return;
      consume(event);
      input.pressed.add(action);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      const action = resolveFreeCamAction(event);
      if (!action) return;
      consume(event);
      input.pressed.delete(action);
    };

    // Sans ça, une touche relâchée hors de la fenêtre (Alt-Tab) resterait enfoncée.
    const releaseAll = () => resetInputState(input);
    const handleVisibilityChange = () => {
      if (document.hidden) releaseAll();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, activeRef, input]);
}
