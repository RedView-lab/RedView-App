import type { KeyboardEvent } from 'react';

/** Entrée ou Espace sur l'élément focalisé = son clic (même gestionnaire, même événement de clic). */
function activateOnKey(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.currentTarget.click();
}

/**
 * Props qui rendent un élément cliquable non natif (texte éditable d'une
 * liste, puce de durée…) atteignable et activable au clavier (WCAG 2.1.1) :
 * focus par Tab, Entrée / Espace déclenchent son `onClick`. Rien quand
 * `enabled` est faux (élément non cliquable). Préférer un vrai `<button>`
 * quand la mise en page le permet.
 */
export function keyboardActivatable(enabled = true): {
  role?: 'button';
  tabIndex?: number;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
} {
  return enabled ? { role: 'button', tabIndex: 0, onKeyDown: activateOnKey } : {};
}
