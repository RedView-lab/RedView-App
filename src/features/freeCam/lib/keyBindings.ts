import type { FreeCamAction } from '../types';
import { FREECAM_TOGGLE_CODE } from './config';

/**
 * Mapping par `KeyboardEvent.code` (position physique) : Z/Q/S/D en AZERTY
 * correspondent à KeyW/KeyA/KeyS/KeyD, donc WASD en QWERTY marche aussi, et
 * Maj/Ctrl ne changent pas le code (contrairement à `event.key`).
 */
const ACTION_BY_CODE: Readonly<Record<string, FreeCamAction>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'ascend',
  ShiftLeft: 'ascend',
  ShiftRight: 'ascend',
  // Cmd (Meta ; OSLeft/OSRight dans les anciens Firefox) descend sur Mac.
  // Ctrl reste la descente universelle (sous Windows Meta = touche Windows,
  // dont le menu Démarrer n'est pas annulable) ; Fn en bonus quand émis (macOS).
  MetaLeft: 'descend',
  MetaRight: 'descend',
  OSLeft: 'descend',
  OSRight: 'descend',
  ControlLeft: 'descend',
  ControlRight: 'descend',
  Fn: 'descend',
};

/** Actions portées par des touches non modificatrices (voir `isMetaKeyCode`). */
export const FREECAM_NON_MODIFIER_ACTIONS: readonly FreeCamAction[] = ['forward', 'backward', 'left', 'right'];

export function resolveFreeCamAction(event: KeyboardEvent): FreeCamAction | null {
  const byCode = ACTION_BY_CODE[event.code];
  if (byCode) return byCode;
  if (event.key === 'Fn') return 'descend';
  return null;
}

/**
 * macOS n'émet pas le `keyup` d'une touche relâchée pendant que Cmd est
 * enfoncé : au relâché de Cmd, les déplacements doivent être relâchés à la main.
 */
export function isMetaKeyCode(code: string): boolean {
  return code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight';
}

export function isFreeCamToggleKey(event: KeyboardEvent): boolean {
  if (event.code !== FREECAM_TOGGLE_CODE) return false;
  if (event.repeat) return false;
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === 'Escape' || event.code === 'Escape';
}
