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
  ShiftLeft: 'ascend',
  ShiftRight: 'ascend',
  // Fn n'atteint jamais le navigateur sous Windows (géré par le firmware
  // clavier) : Ctrl est la descente universelle, Fn en bonus quand émis (macOS).
  ControlLeft: 'descend',
  ControlRight: 'descend',
  Fn: 'descend',
};

export function resolveFreeCamAction(event: KeyboardEvent): FreeCamAction | null {
  const byCode = ACTION_BY_CODE[event.code];
  if (byCode) return byCode;
  if (event.key === 'Fn') return 'descend';
  return null;
}

export function isFreeCamToggleKey(event: KeyboardEvent): boolean {
  if (event.code !== FREECAM_TOGGLE_CODE) return false;
  if (event.repeat) return false;
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function isEscapeKey(event: KeyboardEvent): boolean {
  return event.key === 'Escape' || event.code === 'Escape';
}
