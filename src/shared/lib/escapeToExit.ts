import { isTypingTarget } from './isTypingTarget';

/** Ce que la règle lit d'un `KeyboardEvent` (testable sans DOM). */
export interface EscapeKeyLike {
  key: string;
  defaultPrevented: boolean;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/**
 * `true` si cet Échap doit quitter le mode actif. Une pression = un niveau :
 * ce qui est au-dessus du mode (geste en cours, menu, carte ouverte) consomme
 * Échap avant lui avec `preventDefault`, un Échap tapé dans un champ reste au
 * champ, et une touche maintenue (`repeat`) ne quitte pas plusieurs niveaux.
 */
export function shouldExitModeOnEscape(
  event: EscapeKeyLike,
  isTyping: (target: EventTarget | null) => boolean = isTypingTarget,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isTyping(event.target);
}
