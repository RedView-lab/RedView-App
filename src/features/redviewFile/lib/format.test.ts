import { describe, expect, it } from 'vitest';

import { buildRedviewFileName } from './format';

describe('buildRedviewFileName', () => {
  it('garde accents, espaces et écritures non latines', () => {
    expect(buildRedviewFileName('GT20 « été » 2026')).toBe('GT20 « été » 2026.redview');
    expect(buildRedviewFileName('東京ライド')).toBe('東京ライド.redview');
  });

  it('120 caractères entiers : un émoji n’est jamais coupé en deux', () => {
    const name = buildRedviewFileName(`${'a'.repeat(119)}🚴🚴`);
    expect(name).toBe(`${'a'.repeat(119)}🚴.redview`);
    // aucune moitié de paire de substitution
    expect(/[\uD800-\uDFFF]/.test(name.replace(/🚴/g, ''))).toBe(false);
  });

  it('caractères interdits, contrôles, points de tête et noms réservés', () => {
    expect(buildRedviewFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j.redview');
    expect(buildRedviewFileName('..cache.')).toBe('cache.redview');
    expect(buildRedviewFileName('NUL')).toBe('NUL-projet.redview');
    expect(buildRedviewFileName('   ')).toBe('projet.redview');
  });
});
