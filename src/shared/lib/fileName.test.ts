import { describe, expect, it } from 'vitest';

import { slugFileName } from './fileName';

describe('slugFileName', () => {
  it('garde le format court habituel pour les noms latins', () => {
    expect(slugFileName('Tour du Mont-Blanc', 'itinerary')).toBe('tour-du-mont-blanc');
    expect(slugFileName('Gîte d’étape « Chez Zoé »', 'itinerary')).toBe('gite-d-etape-chez-zoe');
    expect(slugFileName('Boucle E2E', 'itinerary')).toBe('boucle-e2e');
  });

  it('garde les lettres de toute écriture (plus de « itinerary » pour un nom non latin)', () => {
    expect(slugFileName('東京ライド', 'itinerary')).toBe('東京ライド');
    expect(slugFileName('Ελλάδα 2026', 'itinerary')).toBe('ελλαδα-2026');
    expect(slugFileName('हिन्दी मार्ग', 'itinerary')).toBe('हिन्दी-मार्ग');
    expect(slugFileName('طريق الجبل', 'itinerary')).toBe('طريق-الجبل');
  });

  it('retire tout caractère interdit ou dangereux dans un nom de fichier', () => {
    expect(slugFileName('a/b\\c:d*e?f"g<h>i|j', 'x')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(slugFileName('../../etc/passwd', 'x')).toBe('etc-passwd');
    expect(slugFileName('  ...  ', 'x')).toBe('x');
    expect(slugFileName('ligne\u0000\u001fnulle', 'x')).toBe('ligne-nulle');
  });

  it('émojis seuls : le repli ; noms réservés de Windows évités', () => {
    expect(slugFileName('🚴🏔🚴', 'itinerary')).toBe('itinerary');
    expect(slugFileName('CON', 'itinerary')).toBe('con-itinerary');
    expect(slugFileName('lpt1', 'flyover')).toBe('lpt1-flyover');
  });

  it('longueur bornée, sans couper un caractère ni finir par un tiret', () => {
    expect(Array.from(slugFileName('東'.repeat(300), 'x'))).toHaveLength(100);
    expect(slugFileName(`${'a'.repeat(99)} b`, 'x')).toBe('a'.repeat(99));
    expect(slugFileName('𠀀'.repeat(150), 'x')).toBe('𠀀'.repeat(100));
  });
});
