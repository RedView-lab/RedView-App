export type AppLocale = 'fr' | 'en';
type AppTranslationValue = string | number;
export type AppTranslationVars = Record<string, AppTranslationValue>;

export type AppTranslationBundle = {
  locale: AppLocale;
  entries: Record<string, string>;
};

export type AppTranslationPair = {
  fr: string;
  en: string;
};

export const PROJECT_BROWSER_SETTINGS_STORAGE_KEY = 'redview:project-browser-settings:v1';

export const APP_LOCALE_OPTIONS = [
  {
    value: 'en',
    label: 'English (US)',
    flag: '/flags/US.svg',
    flagCode: 'US',
  },
  {
    value: 'fr',
    label: 'Français',
    flag: '/flags/FR.svg',
    flagCode: 'FR',
  },
] as const;
