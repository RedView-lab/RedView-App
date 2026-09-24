/**
 * Keyboard mapping and input helpers for FreeCam mode.
 * Supports French AZERTY (Mac/PC), US QWERTY, and arrow keys.
 */

export interface FreeCamActiveKeys {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  ascend: boolean;
  descend: boolean;
}

export function createEmptyKeys(): FreeCamActiveKeys {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    ascend: false,
    descend: false,
  };
}

/**
 * Checks whether an event originates from an editable input field.
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/**
 * Detects whether the event is the activation shortcut (Alt + Space / Option + Espace).
 */
export function isToggleShortcut(e: KeyboardEvent): boolean {
  if (isEditableElement(e.target)) return false;
  return e.altKey && (e.code === 'Space' || e.key === ' ' || e.keyCode === 32);
}

/**
 * Checks if the key is 'E' (release / regain mouse lock).
 */
export function isMouseToggleKey(e: KeyboardEvent): boolean {
  if (isEditableElement(e.target)) return false;
  return e.code === 'KeyE' || e.key.toLowerCase() === 'e';
}

/**
 * Checks if the key is 'P' (toggle between Mode 3D and Mode Plan).
 */
export function isPlanModeToggleKey(e: KeyboardEvent): boolean {
  if (isEditableElement(e.target)) return false;
  return e.code === 'KeyP' || e.key.toLowerCase() === 'p';
}

/**
 * Updates movement state based on a keydown or keyup event.
 * Handles Z (forward), Q (left), S (backward), D (right),
 * Maj (ascend), Fn / Control / C (descend).
 */
export function updateKeysFromEvent(
  keys: FreeCamActiveKeys,
  e: KeyboardEvent,
  isDown: boolean,
): boolean {
  if (isEditableElement(e.target)) return false;

  const code = e.code;
  const key = e.key.toLowerCase();
  let handled = false;

  // FORWARD: Z on AZERTY, W on QWERTY, ArrowUp
  if (code === 'KeyW' || code === 'KeyZ' || key === 'z' || key === 'w' || code === 'ArrowUp') {
    keys.forward = isDown;
    handled = true;
  }

  // BACKWARD: S on AZERTY / QWERTY, ArrowDown
  if (code === 'KeyS' || key === 's' || code === 'ArrowDown') {
    keys.backward = isDown;
    handled = true;
  }

  // LEFT: Q on AZERTY, A on QWERTY, ArrowLeft
  if (code === 'KeyA' || code === 'KeyQ' || key === 'q' || key === 'a' || code === 'ArrowLeft') {
    keys.left = isDown;
    handled = true;
  }

  // RIGHT: D on AZERTY / QWERTY, ArrowRight
  if (code === 'KeyD' || key === 'd' || code === 'ArrowRight') {
    keys.right = isDown;
    handled = true;
  }

  // ASCEND (Prendre altitude): Maj (Shift)
  if (code === 'ShiftLeft' || code === 'ShiftRight' || key === 'shift') {
    keys.ascend = isDown;
    handled = true;
  }

  // DESCEND (Perdre altitude): Fn / Control / C
  if (
    code === 'ControlLeft' ||
    code === 'ControlRight' ||
    key === 'control' ||
    key === 'fn' ||
    code === 'KeyC' ||
    key === 'c'
  ) {
    keys.descend = isDown;
    handled = true;
  }

  return handled;
}
