/**
 * Plateforme et normalisation des modificateurs clavier.
 *
 * Le projet n'avait pas de helper : les composants testaient `event.ctrlKey`
 * / `event.metaKey` directement. Pour le modificateur « variante » on veut
 * qu'Alt fonctionne partout **et** que Cmd fonctionne sur macOS, sans que la
 * touche Windows (`metaKey` sur Windows) ne déclenche quoi que ce soit.
 */

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: { platform?: string };
}

let cachedIsMacLike: boolean | null = null;

/** `true` sur macOS / iOS (y compris iPadOS qui se déclare « MacIntel »). */
export function isMacLikePlatform(): boolean {
  if (cachedIsMacLike !== null) return cachedIsMacLike;
  if (typeof navigator === 'undefined') return false;

  const nav = navigator as NavigatorWithUserAgentData;
  const platform = nav.userAgentData?.platform || nav.platform || '';
  const userAgent = nav.userAgent || '';

  cachedIsMacLike =
    /mac|iphone|ipad|ipod/i.test(platform) || /macintosh|mac os x/i.test(userAgent);

  return cachedIsMacLike;
}

/** Sous-ensemble d'un événement souris/clavier suffisant pour tester un modificateur. */
export interface KeyboardModifierState {
  altKey: boolean;
  metaKey: boolean;
}

/**
 * `true` quand le modificateur « variante » est maintenu :
 * Alt/Option sur toutes les plateformes, plus Cmd (⌘) sur macOS.
 *
 * `event.altKey` est déjà renseigné par Option sur macOS — le support de
 * `metaKey` n'existe que pour l'habitude Cmd des utilisateurs Mac. Sur Windows
 * `metaKey` correspond à la touche Windows et est volontairement ignoré.
 */
export function isVariantModifierPressed(event: KeyboardModifierState): boolean {
  if (event.altKey) return true;
  return isMacLikePlatform() && event.metaKey;
}

/** Libellé du raccourci à afficher dans les infobulles, selon la plateforme. */
export function variantModifierLabel(): string {
  return isMacLikePlatform() ? '⌥' : 'Alt';
}
