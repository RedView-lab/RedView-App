/**
 * Pages légales publiques : mentions légales, confidentialité, CGU,
 * accessibilité. Le texte (lourd) est chargé à la demande : seules les routes
 * et les liens sont sur le chemin critique.
 */
export { LEGAL_PAGES, legalPagePath, resolveLegalPage, type LegalPageId } from './lib/routes';
export { LegalLinks } from './components/LegalLinks';
