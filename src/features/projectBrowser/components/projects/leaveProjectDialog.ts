import type { AppI18nContextValue } from '@/shared/i18n/appI18nContext';
import type { ConfirmDialogOptions } from '@/shared/lib/appDialog';

/** Confirmation « Quitter le projet » (menu de la carte et pop-in de partage). */
export function leaveProjectDialog(t: AppI18nContextValue['t'], projectName: string): ConfirmDialogOptions {
  return {
    title: t('Quitter « {{name}} » ?', { name: projectName }),
    message: t('Vous n’y aurez plus accès. Son propriétaire pourra vous inviter à nouveau.'),
    confirmLabel: t('Quitter le projet'),
  };
}
