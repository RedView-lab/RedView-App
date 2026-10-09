/**
 * Pages légales : adresses publiques, lisibles sans compte (lien depuis
 * l'écran de connexion, un e-mail, un moteur de recherche). server.mjs et le
 * serveur de dev servent l'app sur ces chemins (repli SPA), App.tsx les rend
 * avant toute vérification de session.
 */

export type LegalPageId = 'legal-notice' | 'privacy' | 'terms' | 'accessibility';

export interface LegalPageRoute {
  id: LegalPageId;
  path: string;
  /** Libellé du lien (texte source français, traduit par t()). */
  label: string;
}

export const LEGAL_PAGES: readonly LegalPageRoute[] = [
  { id: 'legal-notice', path: '/mentions-legales', label: 'Mentions légales' },
  { id: 'privacy', path: '/confidentialite', label: 'Confidentialité' },
  { id: 'terms', path: '/cgu', label: 'Conditions d’utilisation' },
  { id: 'accessibility', path: '/accessibilite', label: 'Accessibilité' },
];

/** Page légale servie à `pathname` (barre finale tolérée), sinon null. */
export function resolveLegalPage(pathname: string): LegalPageId | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return LEGAL_PAGES.find((page) => page.path === normalized)?.id ?? null;
}

export function legalPagePath(id: LegalPageId): string {
  return LEGAL_PAGES.find((page) => page.id === id)!.path;
}
