/**
 * RedView Test-Bench : LiDAR — préparation d'une tuile (CPU)
 *
 * Mesure le VRAI code de la première ouverture d'une tuile dans le viewer
 * (avant le 2026-10-06, ce bench mesurait des copies locales — empaquetage,
 * soleil, ombres — qui n'existaient pas dans l'app) :
 * 1. Reprojection Lambert-93 → WGS84 (src/features/lidar/lib/coordConvert.ts).
 * 2. Colorisation ortho des points (src/features/lidar/lib/orthoSampling.ts),
 *    dalles WMTS z19 déjà décodées, emprise d'une tuile de 1 km.
 * 3. Octree LOD additive + couleurs filtrées (src/features/lidar/viewer/lod/lodTile.ts),
 *    tuile LAS sans hiérarchie COPC (le cas le plus lourd).
 * 4. Découpage en tuiles Web-Mercator (wgs84ToTile).
 * Le décodage laz-perf et la sélection LOD d'une vraie tuile IGN sont dans
 * `npm run bench:lidar-lod` (LIDAR_TILE=…) ; l'ouverture à froid de bout en
 * bout dans Edge dans `npm run bench:lidar-fps -- --cold`.
 */
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { toWgs84, wgs84ToTile } from '../../src/features/lidar/lib/coordConvert.ts';
import { ORTHO_TILE_SIZE, sampleOrthoColors, type OrthoTileGrid } from '../../src/features/lidar/lib/orthoSampling.ts';
import { buildLodTile, type LodTileInput } from '../../src/features/lidar/viewer/lod/lodTile.ts';

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tuile de 1 km de terrain + canopée (secteur du Mont-Blanc), positions relatives à une origine alignée sur le km. */
function syntheticTile(count: number): LodTileInput {
  const rand = mulberry32(42);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const classifications = new Uint8Array(count);
  const intensities = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const x = rand() * 1000;
    const y = rand() * 1000;
    const vegetation = rand() < 0.3;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = 1200 + 350 * Math.sin(x / 300) * Math.cos(y / 240) + (vegetation ? rand() * 25 : 0);
    colors[i * 3] = Math.floor(rand() * 256);
    colors[i * 3 + 1] = Math.floor(x / 4) & 255;
    colors[i * 3 + 2] = Math.floor(y / 4) & 255;
    classifications[i] = vegetation ? 5 : 2;
    intensities[i] = Math.floor(rand() * 4096);
  }
  return {
    positions, colors, classifications, intensities, count,
    bounds: { minX: 990000, minY: 6540000, minZ: 850, maxX: 991000, maxY: 6541000, maxZ: 1600 },
    origin: { x: 990000, y: 6540000, z: 0 },
    crs: 'LAMB93',
  };
}

export async function runLidarBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('LiDAR — préparation d’une tuile (CPU)');
  const iterations = options.quick ? 3 : 8;
  const pointCount = options.quick ? 500_000 : 1_000_000;
  const tile = syntheticTile(pointCount);

  // --- 1. Reprojection Lambert-93 → WGS84 (10k points) ---
  suite.measureSync(
    {
      name: 'Reprojection Lambert-93 → WGS84 (10k pts)',
      category: 'lidar-proj',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      const out = new Float64Array(20_000);
      for (let i = 0; i < 10_000; i++) {
        const [lon, lat] = toWgs84(990_000 + tile.positions[i * 3]!, 6_540_000 + tile.positions[i * 3 + 1]!, 'LAMB93');
        out[i * 2] = lon;
        out[i * 2 + 1] = lat;
      }
      return out;
    },
  );

  // --- 2. Colorisation ortho (z19 ≈ 0,21 m/px à 45° N : ~19 × 19 dalles pour 1 km) ---
  const cols = 20;
  const rows = 20;
  const rand = mulberry32(7);
  const tiles = Array.from({ length: cols * rows }, () => {
    const pixels = new Uint8Array(ORTHO_TILE_SIZE * ORTHO_TILE_SIZE * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = Math.floor(rand() * 256);
      pixels[i + 1] = Math.floor(rand() * 256);
      pixels[i + 2] = Math.floor(rand() * 256);
      pixels[i + 3] = 255;
    }
    return pixels;
  });
  const grid: OrthoTileGrid = { minTileCol: 265_000, minTileRow: 180_000, cols, rows, tiles };
  const x0 = grid.minTileCol * 256 + 60;
  const y0 = grid.minTileRow * 256 + 40;
  const mapping = {
    xMin: 0, yMin: 0, invDx: 1 / 1000, invDy: 1 / 1000,
    px00: x0 + 40, py00: y0 + 4760, px10: x0 + 4800, py10: y0 + 4720,
    px01: x0, py01: y0, px11: x0 + 4760, py11: y0 - 40,
  };
  const colors = new Uint8Array(pointCount * 3);
  suite.measureSync(
    {
      name: `Colorisation ortho bilinéaire (${pointCount / 1e6} M pts)`,
      category: 'lidar-colorize',
      iterations,
      regressionThresholdP95Ms: options.quick ? 120 : 220,
      itemsProcessedPerOp: pointCount,
    },
    () => sampleOrthoColors(tile.positions, colors, 0, pointCount, mapping, grid),
  );

  // --- 3. Octree LOD additive + couleurs filtrées ---
  suite.measureSync(
    {
      name: `Octree LOD + couleurs filtrées (${pointCount / 1e6} M pts, LAS sans COPC)`,
      category: 'lidar-lod-build',
      iterations: Math.max(2, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: options.quick ? 450 : 800,
      itemsProcessedPerOp: pointCount,
    },
    () => buildLodTile(tile),
  );

  // --- 4. Découpage tuiles Web-Mercator (wgs84ToTile) ---
  suite.measureSync(
    {
      name: 'Mapping Tuiles Web-Mercator Zoom 16 (10k pts)',
      category: 'lidar-tiling',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 2.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let sumTiles = 0;
      for (let i = 0; i < 10_000; i++) {
        const { tx, ty } = wgs84ToTile(6.86 + (i % 100) * 0.001, 45.92 + Math.floor(i / 100) * 0.001, 16);
        sumTiles += tx + ty;
      }
      return sumTiles;
    },
  );

  suite.addRegressionRisk(
    'Première ouverture d’une tuile IGN (23 M pts, 2026-10-06) : décodage laz-perf ~17 s CPU (8 workers → ~3,5 s), colorisation ~2 s et octree ~1,8 s sur un seul worker chacune : tout ralentissement de ces boucles se voit tel quel à l’écran.',
  );
  suite.addRecommendation(
    'Suivre l’ouverture à froid réelle avec `npm run bench:lidar-fps -- --cold` (chronologie des étapes) : 14,2 s → 11,2 s le 2026-10-06 sur Radeon 860M, sur batterie.',
  );

  return suite;
}

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/lidar.ts')) {
  const quick = process.argv.includes('--quick');
  runLidarBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
