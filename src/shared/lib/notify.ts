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
  /**
   * Proposition qui se fait d'elle-même (Spotlight de Figma : « Pas
   * maintenant ») : `onTimeout` à la fin du délai, sauf si l'action a été
   * choisie ou le toast fermé. Rend de quoi le retirer (sans `onTimeout`).
   */
  prompt: (
    text: string,
    vars: AppTranslationVars | undefined,
    options: { actionLabel: string; onAction?: () => void; onTimeout?: () => void; durationMs: number },
  ): (() => void) => {
    let settled = false;
    const id = toast(translateAppText(text, vars), {
      duration: options.durationMs,
      action: {
        label: translateAppText(options.actionLabel),
        onClick: () => {
          if (settled) return;
          settled = true;
          options.onAction?.();
        },
      },
      onAutoClose: () => {
        if (settled) return;
        settled = true;
        options.onTimeout?.();
      },
      onDismiss: () => {
        settled = true;
      },
    });
    return () => {
      settled = true;
      toast.dismiss(id);
    };
  },
};
