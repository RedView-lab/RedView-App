export {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  createAppTranslationBundle,
  detectNavigatorAppLocale,
  interpolateAppTranslation,
  isAppLocale,
  readDocumentAppLocale,
  readStoredAppLocale,
  resolveAppLocale,
  translateAppText,
  writeStoredAppLocale,
  type AppLocale,
  type AppTranslationBundle,
  type AppTranslationValue,
  type AppTranslationVars,
} from './config';
export { AppI18nProvider, useAppI18n } from './AppI18nProvider';