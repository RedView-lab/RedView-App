export {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  type AppLocale,
  type AppTranslationBundle,
  
  
  type AppTranslationVars,
} from './types';
export {
  
  
  readDocumentAppLocale,
  readStoredAppLocale,
  resolveAppLocale,
  writeStoredAppLocale,
} from './locale';
export {
  canonicalizeAppText,
  createAppTranslationBundle,
  getAppTranslationBundle,
  interpolateAppTranslation,
  subscribeAppTranslations,
  translateAppText,
} from './bundle';
