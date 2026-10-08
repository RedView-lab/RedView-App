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

/** Clé de recherche : NBSP → espace, apostrophe courbe → droite, espaces réduits. */
export function canonicalizeAppText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function createAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  const entries: Record<string, string> = {};

  // Clés de l'autre langue d'abord, puis les clés propres à la langue : un
  // texte déjà écrit dans la langue cible n'est jamais échangé contre une autre
  // paire qui partage sa traduction (p. ex. 'Gravel' reste 'Gravel' en
  // français bien que { fr: 'Gravier', en: 'Gravel' } existe).
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
  const canonical = canonicalizeAppText(text);
  const translated = canonicalLookup(locale).get(canonical);
  // Un texte déjà dans la langue cible garde sa typographie (apostrophe
  // courbe, espace insécable) au lieu de prendre celle de la paire.
  const result = translated === undefined || canonicalizeAppText(translated) === canonical ? text : translated;
  return interpolateAppTranslation(result, vars);
}
