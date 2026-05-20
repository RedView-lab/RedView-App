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
  for (const pair of APP_TRANSLATION_PAIRS) {
    const target = locale === 'fr' ? pair.fr : pair.en;
    entries[pair.fr] = target;
    entries[pair.en] = target;
  }
  return { locale, entries };
}
