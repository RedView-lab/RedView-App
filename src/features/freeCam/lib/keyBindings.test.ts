import { describe, it, expect } from 'vitest';
import { isMetaKeyCode, resolveFreeCamAction } from './keyBindings';

function key(code: string, key = ''): KeyboardEvent {
  return { code, key } as KeyboardEvent;
}

describe('resolveFreeCamAction', () => {
  it('monte avec Espace ou Maj', () => {
    expect(resolveFreeCamAction(key('Space', ' '))).toBe('ascend');
    expect(resolveFreeCamAction(key('ShiftLeft', 'Shift'))).toBe('ascend');
  });

  it('descend avec Cmd (Mac) ou Ctrl', () => {
    for (const code of ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'ControlLeft', 'ControlRight']) {
      expect(resolveFreeCamAction(key(code))).toBe('descend');
    }
  });

  it('suit la position physique (ZQSD en AZERTY = WASD)', () => {
    expect(resolveFreeCamAction(key('KeyW', 'z'))).toBe('forward');
    expect(resolveFreeCamAction(key('KeyA', 'q'))).toBe('left');
    expect(resolveFreeCamAction(key('KeyE', 'e'))).toBeNull();
  });
});

describe('isMetaKeyCode', () => {
  it('ne reconnaît que Cmd', () => {
    expect(isMetaKeyCode('MetaLeft')).toBe(true);
    expect(isMetaKeyCode('OSRight')).toBe(true);
    expect(isMetaKeyCode('ControlLeft')).toBe(false);
  });
});
