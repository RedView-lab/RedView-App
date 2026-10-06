import { useEffect, useRef, type RefObject } from 'react';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import {
  FREECAM_NON_MODIFIER_ACTIONS,
  isEscapeKey,
  isFreeCamToggleKey,
  isMetaKeyCode,
  resolveFreeCamAction,
} from '../lib/keyBindings';
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

    // Cmd tenu (descente sur Mac) + Z/Q/S/D = raccourcis navigateur : la page
    // annule Cmd+S/D/A, jamais Cmd+W (fermer l'onglet) ni Cmd+Q (quitter, Q
    // en AZERTY) — une confirmation de sortie les rattrape tant que Cmd est tenu.
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    let metaHeld = false;
    const setMetaHeld = (held: boolean) => {
      if (held === metaHeld) return;
      metaHeld = held;
      if (held) window.addEventListener('beforeunload', warnBeforeUnload);
      else window.removeEventListener('beforeunload', warnBeforeUnload);
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
      if (isMetaKeyCode(event.code)) setMetaHeld(true);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!activeRef.current) return;
      const action = resolveFreeCamAction(event);
      if (!action) return;
      consume(event);
      input.pressed.delete(action);
      if (!isMetaKeyCode(event.code)) return;
      setMetaHeld(false);
      // macOS n'a pas émis le keyup des touches relâchées sous Cmd : on les
      // relâche toutes ; une touche encore tenue revient par sa répétition.
      for (const moved of FREECAM_NON_MODIFIER_ACTIONS) input.pressed.delete(moved);
      if (!event.shiftKey) input.pressed.delete('ascend');
      if (event.ctrlKey) input.pressed.add('descend');
    };

    // Sans ça, une touche relâchée hors de la fenêtre (Alt-Tab) resterait enfoncée.
    const releaseAll = () => {
      resetInputState(input);
      setMetaHeld(false);
    };
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
      setMetaHeld(false);
    };
  }, [enabled, activeRef, input]);
}
