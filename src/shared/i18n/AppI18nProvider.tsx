import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  createAppTranslationBundle,
  readStoredAppLocale,
  resolveAppLocale,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationBundle,
  type AppTranslationVars,
} from './config';
import { buildTranslationLookup, observeDomTranslation, translateString } from './domTranslation';

type AppI18nContextValue = {
  locale: AppLocale;
  setLocale: (nextLocale: AppLocale) => void;
  t: (text: string, vars?: AppTranslationVars) => string;
  bundle: AppTranslationBundle;
};

const AppI18nContext = createContext<AppI18nContextValue | null>(null);

export function AppI18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readStoredAppLocale);
  const [bundle, setBundle] = useState<AppTranslationBundle>(() => createAppTranslationBundle(readStoredAppLocale()));

  const translationLookup = useMemo(() => buildTranslationLookup(bundle.entries), [bundle.entries]);

  useEffect(() => {
    document.documentElement.lang = locale;
    writeStoredAppLocale(locale);
  }, [locale]);

  useEffect(() => {
    let cancelled = false;

    setBundle(createAppTranslationBundle(locale));

    void fetch(`/api/app-translations?locale=${locale}`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Translation bundle request failed with ${response.status}`);
        }

        const nextBundle = (await response.json()) as Partial<AppTranslationBundle>;
        if (cancelled) {
          return;
        }

        if (!nextBundle || typeof nextBundle !== 'object' || !nextBundle.entries) {
          throw new Error('Invalid translation bundle payload');
        }

        setBundle({
          locale: resolveAppLocale(nextBundle.locale),
          entries: nextBundle.entries,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setBundle(createAppTranslationBundle(locale));
        }
      });

    return () => {
      cancelled = true;
    };
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

export function useAppI18n(): AppI18nContextValue {
  const context = useContext(AppI18nContext);
  if (!context) {
    throw new Error('useAppI18n must be used within AppI18nProvider');
  }

  return context;
}