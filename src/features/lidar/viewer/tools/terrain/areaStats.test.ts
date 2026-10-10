import { describe, it, expect } from 'vitest';

import { computeAreaStats } from './areaStats';
import type { TerrainField } from './terrainField';

/** Plan incliné de `slopeDeg` vers l'est (le sol monte vers l'est), cellules de 1 m. */
function planeField(slopeDeg = 0): TerrainField {
  const tan = Math.tan((slopeDeg * Math.PI) / 180);
  const altitudeAt = (x: number) => 1000 + x * tan;
  return {
    cell: 1,
    altitudeAt: (x: number) => altitudeAt(x),
    slopeAt: () => ({ slopeDeg, aspectDeg: 270 }),
    drape: (vertices: ReadonlyArray<{ projX: number; projY: number }>) => {
      let surfaceDistanceM = 0;
      return vertices.map((v, i) => {
        if (i > 0) {
          const a = vertices[i - 1]!;
          surfaceDistanceM += Math.hypot(v.projX - a.projX, v.projY - a.projY, altitudeAt(v.projX) - altitudeAt(a.projX));
        }
        return { ...v, altitudeM: altitudeAt(v.projX), surfaceDistanceM };
      });
    },
  } as unknown as TerrainField;
}

const p = (projX: number, projY: number) => ({ projX, projY });
const SQUARE = [p(0, 0), p(100, 0), p(100, 100), p(0, 100)];
// Mêmes sommets dans le mauvais ordre : deux triangles de 2 500 m² qui se touchent au centre.
const BOWTIE = [p(0, 0), p(100, 100), p(100, 0), p(0, 100)];

describe('computeAreaStats — surface en plan (H2-1)', () => {
  it('carré simple : surface exacte', () => {
    const stats = computeAreaStats(planeField(), SQUARE)!;
    expect(stats.planAreaM2).toBeCloseTo(10_000, 6);
    expect(stats.surfaceAreaM2).toBeCloseTo(10_000, 0);
  });

  it('nœud papillon : les deux lobes comptent, comme pour les parts de pente', () => {
    const stats = computeAreaStats(planeField(), BOWTIE)!;
    expect(stats.planAreaM2).toBeCloseTo(5_000, 6);
    expect(stats.surfaceAreaM2).toBeCloseTo(5_000, -1);
  });

  it('nœud papillon sur une pente : surface du sol = plan / cos(pente)', () => {
    const stats = computeAreaStats(planeField(35), BOWTIE)!;
    expect(stats.planAreaM2).toBeCloseTo(5_000, 6);
    expect(stats.surfaceAreaM2 / stats.planAreaM2).toBeCloseTo(1 / Math.cos((35 * Math.PI) / 180), 3);
    expect(stats.shareAbove[35]).toBe(1);
  });

  it('recoupement partiel : la boucle retournée compte (règle pair-impair)', () => {
    // Un carré de 100 m dont le côté ouest fait une boucle croisée hors du carré
    // (arêtes qui se coupent en (−10, 50)) : la formule du lacet soustrait l'un des lobes.
    const loop = [p(0, 0), p(100, 0), p(100, 100), p(0, 100), p(0, 60), p(-20, 40), p(-20, 60), p(0, 40)];
    const stats = computeAreaStats(planeField(), loop)!;
    const fine = evenOddAreaBySampling(loop, 0.05);
    expect(stats.planAreaM2).toBeCloseTo(fine, -1);
  });

  it('polygone simple concave : identique à la formule du lacet', () => {
    const concave = [p(0, 0), p(60, 0), p(60, 60), p(30, 20), p(0, 60)];
    let shoelace = 0;
    for (let k = 0; k < concave.length; k++) {
      const a = concave[k]!;
      const b = concave[(k + 1) % concave.length]!;
      shoelace += a.projX * b.projY - b.projX * a.projY;
    }
    expect(computeAreaStats(planeField(), concave)!.planAreaM2).toBeCloseTo(Math.abs(shoelace) / 2, 6);
  });
});

/** Aire pair-impair par comptage de points sur une grille fine (référence indépendante). */
function evenOddAreaBySampling(vertices: ReadonlyArray<{ projX: number; projY: number }>, step: number): number {
  const xs = vertices.map((v) => v.projX);
  const ys = vertices.map((v) => v.projY);
  let inside = 0;
  for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
      let odd = false;
      for (let k = 0; k < vertices.length; k++) {
        const a = vertices[k]!;
        const b = vertices[(k + 1) % vertices.length]!;
        if ((a.projY <= y) !== (b.projY <= y)) {
          const cx = a.projX + ((y - a.projY) / (b.projY - a.projY)) * (b.projX - a.projX);
          if (cx > x) odd = !odd;
        }
      }
      if (odd) inside++;
    }
  }
  return inside * step * step;
}
