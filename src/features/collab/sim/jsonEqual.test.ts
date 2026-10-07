import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@/features/itineraryPanel/lib/project/canonicalJson';

import { sampleDocument } from './fixtures';
import { jsonEqual } from './jsonEqual';

/** jsonEqual(a, b) doit valoir exactement canonicalJson(a) === canonicalJson(b). */
function agrees(a: unknown, b: unknown): void {
  expect(jsonEqual(a, b)).toBe(canonicalJson(a) === canonicalJson(b));
  expect(jsonEqual(b, a)).toBe(canonicalJson(b) === canonicalJson(a));
}

describe('jsonEqual (égalité de JSON canonique)', () => {
  it('cas limites de JSON : ordre des clés, undefined, fonctions, nombres non finis, -0', () => {
    const fn = () => 1;
    const cases: Array<[unknown, unknown]> = [
      [{ a: 1, b: 2 }, { b: 2, a: 1 }],
      [{ a: 1, b: undefined }, { a: 1 }],
      [{ a: 1, f: fn }, { a: 1 }],
      [[1, undefined], [1, null]],
      [[1, fn], [1, null]],
      [[undefined], []],
      [NaN, null],
      [Infinity, -Infinity],
      [{ x: NaN }, { x: null }],
      [-0, 0],
      [{ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }],
      [{ a: 1 }, { a: '1' }],
      [{ a: null }, {}],
      [{ a: {} }, { a: [] }],
      ['x', 'x'],
      [null, undefined],
      [{ a: 1 }, { a: 1, b: 2 }],
      [[1, 2, 3], [1, 2]],
      [true, 1],
    ];
    for (const [a, b] of cases) agrees(a, b);
  });

  it('documents de projet : égaux, puis une seule valeur changée au fond d’un tracé', () => {
    const a = sampleDocument(1_500);
    const b = JSON.parse(JSON.stringify(a)) as typeof a;
    agrees(a, b);
    const route = (b.itineraries[1] as { gpxRoute?: { points: Array<{ elevationM: number }> } }).gpxRoute!;
    route.points[777].elevationM += 0.1;
    agrees(a, b);
  });

  it('valeurs aléatoires : même verdict que canonicalJson', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    const value = (depth: number): unknown => {
      const kind = depth > 3 ? pick(['n', 's', 'u', 'z']) : pick(['n', 's', 'u', 'z', 'a', 'o', 'o']);
      if (kind === 'n') return pick([0, -0, 1, 2.5, NaN, Infinity]);
      if (kind === 's') return pick(['a', 'b', '']);
      if (kind === 'u') return pick([undefined, null, true, false]);
      if (kind === 'z') return pick([undefined, () => 0]);
      if (kind === 'a') return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1));
      const out: Record<string, unknown> = {};
      for (const key of ['x', 'y', 'z'].slice(0, 1 + Math.floor(random() * 3))) out[key] = value(depth + 1);
      return out;
    };
    for (let round = 0; round < 3_000; round += 1) agrees(value(0), value(0));
  });
});
