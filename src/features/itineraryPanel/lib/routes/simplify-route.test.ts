import { describe, expect, it } from 'vitest';

import { computeGpxQualityTargetPointCount, simplifyPointsByQuality } from './simplify-route';

/** 360 km sinueux et vallonné, un point tous les 12 m, bruit GPS déterministe. */
function route(n: number, seed: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, (_, i) => ({
    lat: 45 + i * 0.000108 + 0.00002 * (rnd() - 0.5),
    lon: 6 + 0.05 * Math.sin(i / 900) + 0.002 * Math.sin(i / 37) + 0.00002 * (rnd() - 0.5),
    elevationM: 600 + 500 * Math.sin(i / 4000) + 40 * Math.sin(i / 150) + 2 * rnd(),
    distanceM: i * 12,
  }));
}

/** Empreinte de la suite des points gardés (indices d'origine). */
function fingerprint(points: Array<{ distanceM?: number }>): number {
  let h = 0;
  for (const p of points) h = (h * 31 + Math.round((p.distanceM ?? 0) / 12)) >>> 0;
  return h;
}

describe('simplifyPointsByQuality', () => {
  const points = route(30_000, 2);

  it('keeps the endpoints, the order and the point budget of each preset', () => {
    for (const quality of ['default', 'balanced', 'max'] as const) {
      const out = simplifyPointsByQuality(points.slice(), quality);
      expect(out.length).toBeLessThanOrEqual(computeGpxQualityTargetPointCount(points, quality));
      expect(out[0].distanceM).toBe(0);
      expect(out[out.length - 1].distanceM).toBe(points[points.length - 1].distanceM);
      for (let i = 1; i < out.length; i++) expect(out[i].distanceM!).toBeGreaterThan(out[i - 1].distanceM!);
    }
  });

  it('keeps exactly the points of the per-tolerance Douglas–Peucker search', () => {
    // Empreintes de l'implémentation qui relançait Douglas–Peucker à chaque
    // tolérance (avant le 2026-10-06) : l'arbre de coupures doit garder les mêmes points.
    const expected = { default: [4320, 3127094956], balanced: [10078, 1019434448], max: [21598, 248182521] } as const;
    for (const [quality, [count, hash]] of Object.entries(expected)) {
      const out = simplifyPointsByQuality(points.slice(), quality as keyof typeof expected);
      expect([out.length, fingerprint(out)]).toEqual([count, hash]);
    }
  });

  it('returns a route already under its point budget as it is', () => {
    // 50 points sur 10 km : sous les 12 points/km du préréglage par défaut.
    const sparse = route(50, 3).map((p, i) => ({ ...p, distanceM: i * 200 }));
    expect(simplifyPointsByQuality(sparse, 'default')).toBe(sparse);
  });
});
