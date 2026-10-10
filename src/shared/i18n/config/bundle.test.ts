import { describe, expect, it } from 'vitest';

import {
  canonicalizeAppText,
  getAppTranslationBundle,
  interpolateAppTranslation,
  registerAppTranslationPairs,
  subscribeAppTranslations,
  translateAppText,
} from './bundle';
import { APP_SHELL_TRANSLATION_PAIRS } from './translations';

describe('translateAppText', () => {
  it('translates a French source text to English and back', () => {
    expect(translateAppText('Projets', undefined, 'en')).toBe('Projects');
    expect(translateAppText('Projects', undefined, 'fr')).toBe('Projets');
  });

  it("keeps a text already written in the target language (the locale's own keys win)", () => {
    // { fr: 'Gravier', en: 'Gravel' } existe, mais 'Gravel' est aussi du français.
    expect(translateAppText('Gravel', undefined, 'fr')).toBe('Gravel');
    expect(translateAppText('Projets', undefined, 'fr')).toBe('Projets');
  });

  it('keeps the typography of a text already in the target language', () => {
    const [pair] = APP_SHELL_TRANSLATION_PAIRS.filter((p) => p.fr.includes("'"));
    const curly = pair.fr.replace(/'/g, '’');
    expect(translateAppText(curly, undefined, 'fr')).toBe(curly);
    expect(translateAppText(curly, undefined, 'en')).toBe(pair.en);
  });

  it('matches through non-breaking spaces, curly apostrophes and extra whitespace', () => {
    expect(translateAppText('  Sans nom ', undefined, 'en')).toBe('Untitled');
  });

  it('returns an unknown text unchanged, interpolated', () => {
    expect(translateAppText('Texte inconnu {{n}}', { n: 3 }, 'en')).toBe('Texte inconnu 3');
  });

  it('defaults to French outside the browser', () => {
    expect(translateAppText('Projects')).toBe('Projets');
  });
});

describe('registerAppTranslationPairs', () => {
  it('adds a lot of pairs once, refreshes the dictionaries and notifies subscribers', () => {
    const lot = [{ fr: 'Texte ajouté par un chunk', en: 'Text added by a chunk' }];
    const before = getAppTranslationBundle('en');
    expect(translateAppText('Texte ajouté par un chunk', undefined, 'en')).toBe('Texte ajouté par un chunk');

    let notified = 0;
    const unsubscribe = subscribeAppTranslations(() => {
      notified += 1;
    });
    registerAppTranslationPairs(lot);
    registerAppTranslationPairs(lot);
    unsubscribe();

    expect(notified).toBe(1);
    const after = getAppTranslationBundle('en');
    expect(after).not.toBe(before);
    expect(getAppTranslationBundle('en')).toBe(after);
    expect(after.entries['Texte ajouté par un chunk']).toBe('Text added by a chunk');
    expect(translateAppText('Texte ajouté par un chunk', undefined, 'en')).toBe('Text added by a chunk');
    expect(translateAppText('Text added by a chunk', undefined, 'fr')).toBe('Texte ajouté par un chunk');
  });
});

describe('interpolateAppTranslation', () => {
  it('replaces known placeholders and leaves missing ones visible', () => {
    expect(interpolateAppTranslation('{{ count }} projets, {{missing}}', { count: 2 })).toBe('2 projets, {{missing}}');
  });
});

describe('canonicalizeAppText', () => {
  it('normalises the lookup key', () => {
    expect(canonicalizeAppText('L’itinéraire  du  jour\n')).toBe("L'itinéraire du jour");
  });
});
