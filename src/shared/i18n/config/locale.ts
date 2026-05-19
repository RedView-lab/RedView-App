import { PROJECT_BROWSER_SETTINGS_STORAGE_KEY, type AppLocale } from './types';

const LEGACY_LANGUAGE_TO_LOCALE: Record<string, AppLocale> = {
  en: 'en',
  fr: 'fr',
  'English (US)': 'en',
  Français: 'fr',
};

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'fr' || value === 'en';
}

export function resolveAppLocale(value: unknown): AppLocale {
  if (Array.isArray(value)) {
    return resolveAppLocale(value[0]);
  }

  if (typeof value !== 'string') {
    return 'fr';
  }

  return LEGACY_LANGUAGE_TO_LOCALE[value] ?? (value.toLowerCase().startsWith('en') ? 'en' : 'fr');
}

export function detectNavigatorAppLocale(): AppLocale {
  if (typeof navigator === 'undefined') {
    return 'fr';
  }

  return resolveAppLocale(navigator.language);
}

export function readStoredAppLocale(): AppLocale {
  if (typeof window === 'undefined') {
    return 'fr';
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return detectNavigatorAppLocale();
    }

    const parsed = JSON.parse(raw) as { language?: unknown };
    return resolveAppLocale(parsed.language);
  } catch {
    return detectNavigatorAppLocale();
  }
}

export function writeStoredAppLocale(locale: AppLocale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(
      PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        language: locale,
      }),
    );
  } catch {
    // Best effort only.
  }
}

export function readDocumentAppLocale(): AppLocale {
  if (typeof document !== 'undefined') {
    return resolveAppLocale(document.documentElement.lang || undefined);
  }

  return readStoredAppLocale();
}
