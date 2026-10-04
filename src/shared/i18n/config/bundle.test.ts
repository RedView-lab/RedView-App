import { describe, expect, it } from 'vitest';

import { canonicalizeAppText, interpolateAppTranslation, translateAppText } from './bundle';

describe('translateAppText', () => {
  it('translates a French source text to English and back', () => {
    expect(translateAppText('Projets', undefined, 'en')).toBe('Projects');
    expect(translateAppText('Projects', undefined, 'fr')).toBe('Projets');
  });

  it("keeps a text already written in the target language (the locale's own keys win)", () => {
    // { fr: 'Gravier', en: 'Gravel' } exists, but 'Gravel' is also French.
    expect(translateAppText('Gravel', undefined, 'fr')).toBe('Gravel');
    expect(translateAppText('Projets', undefined, 'fr')).toBe('Projets');
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
