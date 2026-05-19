export type AppLocale = 'fr' | 'en';
export type AppTranslationValue = string | number;
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
    flag: '/landing/svg/US.svg',
    flagCode: 'US',
  },
  {
    value: 'fr',
    label: 'Français',
    flag: '/landing/svg/FR.svg',
    flagCode: 'FR',
  },
] as const;
