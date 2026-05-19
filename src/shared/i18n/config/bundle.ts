import { readDocumentAppLocale } from './locale';
import { APP_TRANSLATION_PAIRS } from './translations';
import type { AppLocale, AppTranslationBundle, AppTranslationVars } from './types';

export function interpolateAppTranslation(template: string, vars?: AppTranslationVars): string {
  if (!vars) {
    return template;
  }

  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
    const value = vars[key];
    return value == null ? match : String(value);
  });
}

export function createAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  const entries: Record<string, string> = {};

  for (const pair of APP_TRANSLATION_PAIRS) {
    const target = locale === 'fr' ? pair.fr : pair.en;
    entries[pair.fr] = target;
    entries[pair.en] = target;
  }

  return {
    locale,
    entries,
  };
}

export function translateAppText(
  text: string,
  vars?: AppTranslationVars,
  locale: AppLocale = readDocumentAppLocale(),
): string {
  const bundle = createAppTranslationBundle(locale);
  const translated = bundle.entries[text] ?? text;
  return interpolateAppTranslation(translated, vars);
}
