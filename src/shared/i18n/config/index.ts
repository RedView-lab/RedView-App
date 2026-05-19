export {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  type AppLocale,
  type AppTranslationBundle,
  type AppTranslationPair,
  type AppTranslationValue,
  type AppTranslationVars,
} from './types';
export {
  detectNavigatorAppLocale,
  isAppLocale,
  readDocumentAppLocale,
  readStoredAppLocale,
  resolveAppLocale,
  writeStoredAppLocale,
} from './locale';
export {
  createAppTranslationBundle,
  interpolateAppTranslation,
  translateAppText,
} from './bundle';
