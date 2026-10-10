import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  createAppTranslationBundle,
  getAppTranslationBundle,
  readStoredAppLocale,
  subscribeAppTranslations,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationVars,
} from './config';
import { AppI18nContext, type AppI18nContextValue } from './appI18nContext';
import { buildTranslationLookup, observeDomTranslation, translateString } from './domTranslation';

export function AppI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readStoredAppLocale);
  // Les paires sont livrées avec le code qui les affiche
  // (shared/i18n/config/translations) : rien à récupérer.
  // `/api/app-translations` renvoyait le même dictionnaire à chaque chargement
  // (264 Kio non compressés), puis tout le DOM était retraduit. Celles de
  // l'éditeur s'ajoutent quand il se charge : nouveau dictionnaire, et
  // l'observateur ci-dessous repasse sur le DOM.
  const getBundle = useCallback(() => getAppTranslationBundle(locale), [locale]);
  const bundle = useSyncExternalStore(subscribeAppTranslations, getBundle, getBundle);

  const translationLookup = useMemo(() => buildTranslationLookup(bundle.entries), [bundle.entries]);

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStoredAppLocale(locale);
  }, [locale]);

  // document.body, pas #root : les portails (menus, fenêtres modales,
  // sélecteur de couleur) se montent directement dans <body> et doivent être
  // traduits aussi.
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
