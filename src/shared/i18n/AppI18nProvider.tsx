import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  createAppTranslationBundle,
  readStoredAppLocale,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationVars,
} from './config';
import { AppI18nContext, type AppI18nContextValue } from './appI18nContext';
import { buildTranslationLookup, observeDomTranslation, translateString } from './domTranslation';

export function AppI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readStoredAppLocale);
  // Every pair ships with the app (shared/i18n/config/translations): nothing to
  // fetch. `/api/app-translations` used to send the same dictionary again on
  // every load (264 KiB uncompressed), then the whole DOM was re-translated.
  const bundle = useMemo(() => createAppTranslationBundle(locale), [locale]);

  const translationLookup = useMemo(() => buildTranslationLookup(bundle.entries), [bundle.entries]);

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStoredAppLocale(locale);
  }, [locale]);

  // document.body, not #root: portals (menus, modals, color picker) mount
  // directly on <body> and must be translated too.
  useEffect(() => observeDomTranslation(document.body, translationLookup), [translationLookup]);

  const value = useMemo<AppI18nContextValue>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (text: string, vars?: AppTranslationVars) => translateString(text, translationLookup, vars),
      bundle,
    }),
    [bundle, locale, translationLookup],
  );

  return <AppI18nContext.Provider value={value}>{children}</AppI18nContext.Provider>;
}

/**
 * Hors de l'application (viewer LiDAR) : mêmes traductions pour des
 * composants React de l'app, sans second observateur DOM (le viewer a le sien,
 * shared/i18n/domTranslation.ts) ni changement de langue.
 */
export function AppI18nStaticProvider({ children }: { children: ReactNode }) {
  const value = useMemo<AppI18nContextValue>(() => {
    const locale = readStoredAppLocale();
    const bundle = createAppTranslationBundle(locale);
    const lookup = buildTranslationLookup(bundle.entries);
    return {
      locale,
      setLocale: () => undefined,
      t: (text: string, vars?: AppTranslationVars) => translateString(text, lookup, vars),
      bundle,
    };
  }, []);
  return <AppI18nContext.Provider value={value}>{children}</AppI18nContext.Provider>;
}
