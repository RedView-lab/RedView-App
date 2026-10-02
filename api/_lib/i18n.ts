import { APP_TRANSLATION_PAIRS } from './translations-data.js';

type AppLocale = 'fr' | 'en';
type AppTranslationBundle = { locale: AppLocale; entries: Record<string, string> };

const LEGACY: Record<string, AppLocale> = {
  en: 'en', fr: 'fr', 'English (US)': 'en', 'Français': 'fr',
};

export function resolveAppLocale(value: unknown): AppLocale {
  if (Array.isArray(value)) return resolveAppLocale(value[0]);
  if (typeof value !== 'string') return 'fr';
  return LEGACY[value] ?? (value.toLowerCase().startsWith('en') ? 'en' : 'fr');
}

export function createAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  const entries: Record<string, string> = {};
  // Same order as the client bundle (src/shared/i18n/config/bundle.ts):
  // the locale's own keys win over the other language's.
  const sourceLocale: AppLocale = locale === 'fr' ? 'en' : 'fr';
  for (const pair of APP_TRANSLATION_PAIRS) entries[pair[sourceLocale]] = pair[locale];
  for (const pair of APP_TRANSLATION_PAIRS) entries[pair[locale]] = pair[locale];
  return { locale, entries };
}
