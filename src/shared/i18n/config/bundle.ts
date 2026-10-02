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

/** Key used for lookups: NBSP → space, curly → straight apostrophe, collapsed whitespace. */
export function canonicalizeAppText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function createAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  const entries: Record<string, string> = {};

  // Keys of the other language first, then the locale's own keys: a text
  // already written in the target language is never swapped for another pair
  // sharing its translation (e.g. 'Gravel' stays 'Gravel' in French although
  // { fr: 'Gravier', en: 'Gravel' } exists).
  const sourceLocale: AppLocale = locale === 'fr' ? 'en' : 'fr';
  for (const pair of APP_TRANSLATION_PAIRS) {
    entries[pair[sourceLocale]] = pair[locale];
  }
  for (const pair of APP_TRANSLATION_PAIRS) {
    entries[pair[locale]] = pair[locale];
  }

  return {
    locale,
    entries,
  };
}

const canonicalLookupByLocale = new Map<AppLocale, Map<string, string>>();

function canonicalLookup(locale: AppLocale): Map<string, string> {
  let lookup = canonicalLookupByLocale.get(locale);
  if (!lookup) {
    lookup = new Map();
    for (const [source, target] of Object.entries(createAppTranslationBundle(locale).entries)) {
      lookup.set(canonicalizeAppText(source), target);
    }
    canonicalLookupByLocale.set(locale, lookup);
  }
  return lookup;
}

export function translateAppText(
  text: string,
  vars?: AppTranslationVars,
  locale: AppLocale = readDocumentAppLocale(),
): string {
  const translated = canonicalLookup(locale).get(canonicalizeAppText(text)) ?? text;
  return interpolateAppTranslation(translated, vars);
}
