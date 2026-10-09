import { useAppI18n } from '@/shared/i18n';

/**
 * Mention « (nouvel onglet) » lue par les lecteurs d'écran seulement, à
 * placer à la fin du texte d'un lien `target="_blank"` (WCAG G201) : le
 * changement de contexte est annoncé avant l'activation.
 */
export function NewTabHint() {
  const { t } = useAppI18n();
  return (
    <>
      {' '}
      <span className="rv-sr-only">{t('(nouvel onglet)')}</span>
    </>
  );
}
