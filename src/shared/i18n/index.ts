export {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  createAppTranslationBundle,
  detectNavigatorAppLocale,
  isAppLocale,
  readStoredAppLocale,
  resolveAppLocale,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationBundle,
} from './config';
export { AppI18nProvider, useAppI18n } from './AppI18nProvider';