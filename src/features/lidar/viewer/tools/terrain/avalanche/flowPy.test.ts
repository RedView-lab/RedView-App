import { describe, expect, it } from 'vitest';
import { prepareFlowPyTerrain, runFlowPyToTarget, type FlowPyGrid, type FlowPyResult } from './flowPy';

const CELL = 10;
const DEG = Math.PI / 180;

function grid(width: number, height: number, altitudeAt: (x: number, y: number) => number): FlowPyGrid {
  const altitude = new Float32Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) altitude[r * width + c] = altitudeAt(c * CELL, r * CELL);
  return { width, height, cell: CELL, altitude };
}

/** Un versant à 36° avec des ravines et un micro-relief tiré d'une graine, puis un fond de vallée. */
function gulliesGrid(): FlowPyGrid {
  let seed = 9;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  const noise = Float32Array.from({ length: 70 * 50 }, () => rand() * 3);
  return grid(70, 50, (x, y) => {
    const face = x < 450 ? (450 - x) * Math.tan(36 * DEG) : 0;
    return 1000 + face + 15 * Math.abs(Math.sin(y / 70)) + noise[(y / CELL) * 70 + x / CELL]!;
  });
}

/** Cellules de départ : chaque cellule intérieure du versant plus raide que ~30°. */
function faceRelease(g: FlowPyGrid): Uint8Array {
  const release = new Uint8Array(g.altitude.length);
  for (let r = 1; r < g.height - 1; r++) {
    for (let c = 1; c < 40; c++) release[r * g.width + c] = 1;
  }
  return release;
}

function disc(g: FlowPyGrid, col: number, row: number): Int32Array {
  const cells: number[] = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) cells.push((row + dr) * g.width + col + dc);
  return Int32Array.from(cells);
}

/** FNV-1a sur chaque nombre du résultat (tableaux typés et scalaires, dans l'ordre des clés). */
function fingerprint(result: FlowPyResult): string {
  const values: number[] = [];
  for (const key of Object.keys(result).sort()) {
    const value = (result as unknown as Record<string, unknown>)[key];
    if (ArrayBuffer.isView(value)) values.push(...Array.from(value as Float32Array));
    else if (typeof value === 'number') values.push(value);
    else if (typeof value === 'boolean') values.push(value ? 1 : 0);
    else values.push(-1);
  }
  const bytes = new Uint8Array(Float64Array.from(values).buffer);
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${values.length}:${(hash >>> 0).toString(16)}`;
}

describe('runFlowPyToTarget', () => {
  const g = gulliesGrid();
  const terrain = prepareFlowPyTerrain(g);
  const release = faceRelease(g);
  const target = { cells: disc(g, 52, 25) };

  it('gives the same result as before the hot-loop rewrite', () => {
    // Bande de cellules de départ (rangées 20 à 28) : empreintes calculées par le
    // code d'avant la réécriture (c608df3) et identiques au code actuel. Sur tout
    // le versant (3782:9e8d731f, 5930:9f29df7d, mêmes deux codes) le test coûtait
    // 7× plus et dépassait 5 s sous couverture v8.
    const band = release.map((value, i) => (Math.floor(i / g.width) >= 20 && Math.floor(i / g.width) <= 28 ? value : 0));
    const typical = runFlowPyToTarget(g, terrain, target, { alphaDeg: 30, fsi: null, release: band });
    const infrequent = runFlowPyToTarget(g, terrain, target, { alphaDeg: 18, fsi: null, release: band });
    expect(typical.startCells.length).toBeGreaterThan(0);
    expect(infrequent.startCells.length).toBeGreaterThan(typical.startCells.length);
    expect([fingerprint(typical), fingerprint(infrequent)]).toEqual(['1542:44cc3d3b', '2214:3ccaf88e']);
  });

  it('stops early with exactly the exhaustive result, forest included', () => {
    // Une bande de cellules de départ : la référence exhaustive suit chaque écoulement jusqu'au bout.
    const band = release.map((value, i) => (Math.floor(i / g.width) >= 20 && Math.floor(i / g.width) <= 28 ? value : 0));
    const fsi = Float32Array.from({ length: g.altitude.length }, (_, i) => ((i % g.width) > 30 && (i % g.width) < 48 ? 0.6 : 0));
    for (const alphaDeg of [30, 18]) {
      for (const forest of [null, fsi]) {
        const early = runFlowPyToTarget(g, terrain, target, { alphaDeg, fsi: forest, release: band });
        const exhaustive = runFlowPyToTarget(g, terrain, target, { alphaDeg, fsi: forest, release: band, exhaustive: true });
        expect({ ...early, processed: 0 }).toEqual({ ...exhaustive, processed: 0 });
        expect(early.processed).toBeLessThan(exhaustive.processed);
      }
    }
  });

  it('stops near the energy line drawn at α from the release cell', () => {
    // Versant plan à 38°, puis plat : la ligne α 30° depuis le haut rencontre le
    // fond à H / tan 30° ; l'écoulement s'arrête quelques cellules avant, son flux
    // étalé sur la pente passant sous le seuil d'acheminement.
    const width = 140;
    const plane = grid(width, 9, (x) => (x < 400 ? (400 - x) * Math.tan(38 * DEG) : 0));
    const planeTerrain = prepareFlowPyTerrain(plane);
    const top = new Uint8Array(plane.altitude.length);
    top[4 * width + 2] = 1;
    const reach = (col: number) => runFlowPyToTarget(plane, planeTerrain, { cells: Int32Array.of(4 * width + col) }, {
      alphaDeg: 30, fsi: null, release: top,
    }).startCells.length > 0;
    const runoutM = (400 - 2 * CELL) * Math.tan(38 * DEG) / Math.tan(30 * DEG) + 2 * CELL;
    const lastCol = Math.floor(runoutM / CELL);
    expect(reach(lastCol - 5)).toBe(true);
    expect(reach(lastCol + 3)).toBe(false);
  });
});
