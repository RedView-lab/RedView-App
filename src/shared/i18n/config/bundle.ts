import { readDocumentAppLocale } from './locale';
import { APP_SHELL_TRANSLATION_PAIRS } from './translations';
import type { AppLocale, AppTranslationBundle, AppTranslationPair, AppTranslationVars } from './types';

/**
 * Paires connues de l'application. Celles du gestionnaire de projets, de la
 * connexion et des écrans hors éditeur sont livrées au chargement ; celles de
 * l'éditeur 3D et du visualiseur LiDAR s'ajoutent quand leur code arrive
 * (`registerEditorTranslations.ts`) — 60 % du dictionnaire, qui pesait sur le
 * chemin critique du gestionnaire (scripts/quality/check-bundle.mjs).
 */
const registeredPairs: Array<ReadonlyArray<AppTranslationPair>> = [APP_SHELL_TRANSLATION_PAIRS];
const registryListeners = new Set<() => void>();
const bundleByLocale = new Map<AppLocale, AppTranslationBundle>();
const canonicalLookupByLocale = new Map<AppLocale, Map<string, string>>();

/** Ajoute un lot de paires (sans effet s'il est déjà enregistré) et prévient les abonnés. */
export function registerAppTranslationPairs(pairs: ReadonlyArray<AppTranslationPair>): void {
  if (registeredPairs.includes(pairs)) return;
  registeredPairs.push(pairs);
  canonicalLookupByLocale.clear();
  bundleByLocale.clear();
  for (const listener of registryListeners) listener();
}

export function subscribeAppTranslations(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

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
  for (const pairs of registeredPairs) {
    for (const pair of pairs) entries[pair[sourceLocale]] = pair[locale];
  }
  for (const pairs of registeredPairs) {
    for (const pair of pairs) entries[pair[locale]] = pair[locale];
  }

  return {
    locale,
    entries,
  };
}

/** Dictionnaire courant d'une langue : même objet tant qu'aucune paire n'est ajoutée (instantané de `useSyncExternalStore`). */
export function getAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  let bundle = bundleByLocale.get(locale);
  if (!bundle) {
    bundle = createAppTranslationBundle(locale);
    bundleByLocale.set(locale, bundle);
  }
  return bundle;
}

function canonicalLookup(locale: AppLocale): Map<string, string> {
  let lookup = canonicalLookupByLocale.get(locale);
  if (!lookup) {
    lookup = new Map();
    for (const [source, target] of Object.entries(getAppTranslationBundle(locale).entries)) {
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
