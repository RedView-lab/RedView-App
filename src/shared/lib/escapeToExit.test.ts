import { describe, it, expect } from 'vitest';
import { shouldExitModeOnEscape, type EscapeKeyLike } from './escapeToExit';

const notTyping = () => false;
const typing = () => true;

function key(overrides: Partial<EscapeKeyLike> = {}): EscapeKeyLike {
  return {
    key: 'Escape',
    defaultPrevented: false,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: null,
    ...overrides,
  };
}

describe('shouldExitModeOnEscape', () => {
  it('quitte le mode sur un Échap simple', () => {
    expect(shouldExitModeOnEscape(key(), notTyping)).toBe(true);
  });

  it('ignore les autres touches', () => {
    expect(shouldExitModeOnEscape(key({ key: 'Enter' }), notTyping)).toBe(false);
  });

  it('laisse la priorité à ce qui a déjà consommé Échap (menu, geste en cours)', () => {
    expect(shouldExitModeOnEscape(key({ defaultPrevented: true }), notTyping)).toBe(false);
  });

  it('laisse Échap au champ de saisie', () => {
    expect(shouldExitModeOnEscape(key(), typing)).toBe(false);
  });

  it('ne quitte pas plusieurs niveaux quand la touche est maintenue', () => {
    expect(shouldExitModeOnEscape(key({ repeat: true }), notTyping)).toBe(false);
  });

  it('ignore Échap avec un modificateur', () => {
    expect(shouldExitModeOnEscape(key({ ctrlKey: true }), notTyping)).toBe(false);
    expect(shouldExitModeOnEscape(key({ metaKey: true }), notTyping)).toBe(false);
    expect(shouldExitModeOnEscape(key({ altKey: true }), notTyping)).toBe(false);
  });
});
