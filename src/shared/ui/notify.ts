import { toast } from 'sonner';

import { translateAppText, type AppTranslationVars } from '@/shared/i18n';

/**
 * Notifications éphémères (toasts) : la seule API à appeler dans l'app. Le
 * texte source (FR/EN, cf. CLAUDE.md i18n) est traduit ici ; rendu et durée
 * communs dans AppToaster. La bibliothèque (sonner) reste un détail
 * d'implémentation de ce module.
 */
export const notify = {
  success: (text: string, vars?: AppTranslationVars) => {
    toast.success(translateAppText(text, vars));
  },
  error: (text: string, vars?: AppTranslationVars) => {
    toast.error(translateAppText(text, vars));
  },
  info: (text: string, vars?: AppTranslationVars) => {
    toast.info(translateAppText(text, vars));
  },
};
