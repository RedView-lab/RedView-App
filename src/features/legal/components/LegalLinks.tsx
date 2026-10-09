import { NewTabHint } from '@/shared/components/NewTabHint';
import { useAppI18n } from '@/shared/i18n';
import { LEGAL_PAGES } from '../lib/routes';

/**
 * Liens vers les pages légales (écran de connexion, Réglages), ouverts dans
 * un nouvel onglet : la session et le projet en cours restent intacts.
 */
export function LegalLinks({ className }: { className?: string }) {
  const { t } = useAppI18n();
  return (
    <nav className={className} aria-label={t('Informations légales')}>
      {LEGAL_PAGES.map((page) => (
        <a key={page.id} href={page.path} target="_blank" rel="noreferrer">
          {t(page.label)}
          <NewTabHint />
        </a>
      ))}
    </nav>
  );
}
