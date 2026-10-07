export {
  APP_LOCALE_OPTIONS,
  PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
  canonicalizeAppText,
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
export { AppI18nProvider } from './AppI18nProvider';
export { useAppI18n } from './appI18nContext';
export { buildTranslationLookup, observeDomTranslation } from './domTranslation';
