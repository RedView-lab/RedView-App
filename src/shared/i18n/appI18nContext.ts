import { createContext, useContext } from 'react';

import type { AppLocale, AppTranslationBundle, AppTranslationVars } from './config';

export type AppI18nContextValue = {
  locale: AppLocale;
  setLocale: (nextLocale: AppLocale) => void;
  t: (text: string, vars?: AppTranslationVars) => string;
  bundle: AppTranslationBundle;
};

export const AppI18nContext = createContext<AppI18nContextValue | null>(null);

export function useAppI18n(): AppI18nContextValue {
  const context = useContext(AppI18nContext);
  if (!context) {
    throw new Error('useAppI18n must be used within AppI18nProvider');
  }

  return context;
}
