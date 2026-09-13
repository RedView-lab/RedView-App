/**
 * RedView Test-Bench : Pente (Slope Engine & Horn 3x3)
 * 
 * Benchmarks :
 * 1. Noyau différentiel Horn 3x3 sur grilles MNT (128x128, 256x256, 512x512)
 * 2. Génération de tuile raster serveur (/slope-tiles/:z/:x/:y) avec encodage sqrt-gamma PNG
 * 3. Compilation des expressions Mapbox raster-color (buildSlopeColorExpression)
 * 4. Algorithme de lissage de gradient le long d'une trace (10 000 points)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticDemGrid, generateSyntheticRoute } from './core/synthetic-data.ts';
import { buildSlopeColorExpression } from '../src/features/slope/lib/slope-config.ts';
import { generateSlopeTile } from '../server/terrain-tiles.mjs';
import type { SlopeCategory } from '../src/features/slope/types.ts';

export async function runSlopeBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Pente (Slope & Horn 3x3)');
  const iterations = options.quick ? 5 : 20;

  // Préparation des grilles synthétiques
  const grid128 = generateSyntheticDemGrid(128, 128);
  const grid256 = generateSyntheticDemGrid(256, 256);
  const grid512 = generateSyntheticDemGrid(512, 512);
  const route10k = generateSyntheticRoute(10_000);

  const sampleCategories: SlopeCategory[] = [
    { id: 'flat', label: '0% - 5%', minDeg: 0, maxDeg: 2.86, color: '#2DBF8C' },
    { id: 'gentle', label: '5% - 8%', minDeg: 2.86, maxDeg: 4.57, color: '#7CD95F' },
    { id: 'moderate', label: '8% - 12%', minDeg: 4.57, maxDeg: 6.84, color: '#FFD800' },
    { id: 'steep', label: '12% - 16%', minDeg: 6.84, maxDeg: 9.09, color: '#FF7200' },
    { id: 'wall', label: '> 16%', minDeg: 9.09, maxDeg: 45, color: '#FF0000' },
  ];

  // --- BENCHMARK 1 : Horn 3x3 Kernel sur 128x128 ---
  suite.measureSync(
    {
      name: 'Noyau Horn 3x3 (128x128 MNT)',
      category: 'slope-horn-128',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 6.0,
      itemsProcessedPerOp: 128 * 128,
    },
    () => executeHornKernel(grid128, 128, 128, 10.0),
  );

  // --- BENCHMARK 2 : Horn 3x3 Kernel sur 256x256 (Taille tuile standard) ---
  suite.measureSync(
    {
      name: 'Noyau Horn 3x3 (256x256 MNT standard)',
      category: 'slope-horn-256',
      iterations,
      regressionThresholdP95Ms: 4.0,
      itemsProcessedPerOp: 256 * 256,
    },
    () => executeHornKernel(grid256, 256, 256, 5.0),
  );

  // --- BENCHMARK 3 : Horn 3x3 Kernel sur 512x512 (Haute Résolution) ---
  suite.measureSync(
    {
      name: 'Noyau Horn 3x3 (512x512 MNT HD)',
      category: 'slope-horn-512',
      iterations: Math.max(3, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 512 * 512,
    },
    () => executeHornKernel(grid512, 512, 512, 2.5),
  );

  // --- BENCHMARK 4 : Compilation de l'expression Mapbox raster-color ---
  suite.measureSync(
    {
      name: 'Compilation Mapbox Expression (Gradient)',
      category: 'slope-expression',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 0.5,
    },
    () => buildSlopeColorExpression(sampleCategories, 'gradient'),
  );

  suite.measureSync(
    {
      name: 'Compilation Mapbox Expression (Step + Masque)',
      category: 'slope-expression',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 0.5,
    },
    () => buildSlopeColorExpression(sampleCategories, 'step', ['moderate']),
  );

  // --- BENCHMARK 5 : Lissage de gradient trace (10 000 points, fenêtre 200m) ---
  suite.measureSync(
    {
      name: 'Lissage Gradient Trace (10k pts, 200m)',
      category: 'slope-smoothing',
      iterations,
      regressionThresholdP95Ms: 8.0,
      itemsProcessedPerOp: 10_000,
    },
    () => smoothGradientsAlongTrack(route10k, 200),
  );

  // --- BENCHMARK 6 : Générateur de Tuile Serveur (/slope-tiles/:z/:x/:y) ---
  try {
    await suite.measureAsync(
      {
        name: 'Génération Tuile Serveur (/slope-tiles)',
        category: 'slope-tile-server',
        iterations: options.quick ? 3 : 8,
        regressionThresholdP95Ms: 120.0,
      },
      async () => {
        // Zoom 12 au dessus des Alpes
        return await generateSlopeTile(12, 2124, 1445);
      },
    );
  } catch {
    // Si pas de connexion réseau externe AWS S3
  }

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Bordures de tuiles MNT : discontinuités du filtre Horn sans padding 1px (halo artefact sur les joints de tuiles).',
  );
  suite.addRegressionRisk(
    'Coût CPU Horn 512x512 sur mobile : 512x512 exige 262k opérations trigonométriques Math.atan/hypot.',
  );
  suite.addRecommendation(
    'Compiler le noyau Horn en WebAssembly ou déporter le calcul dans un CustomLayer WebGL (calcul direct sur le GPU fragment shader).',
  );
  suite.addRecommendation(
    'Pré-calculer une LUT (Look-Up Table) pour remplacer Math.atan(hypot) * (180 / Math.PI) par un accès direct Uint8.',
  );

  return suite;
}

function executeHornKernel(
  elev: Float32Array,
  width: number,
  height: number,
  cellSize: number,
): Float32Array {
  const inv8Cell = 1.0 / (8.0 * cellSize);
  const rad2deg = 180.0 / Math.PI;
  const slopes = new Float32Array(width * height);

  for (let r = 1; r < height - 1; r++) {
    const rowPrev = (r - 1) * width;
    const rowCur = r * width;
    const rowNext = (r + 1) * width;

    for (let c = 1; c < width - 1; c++) {
      const z_nw = elev[rowPrev + c - 1];
      const z_n  = elev[rowPrev + c];
      const z_ne = elev[rowPrev + c + 1];
      const z_w  = elev[rowCur + c - 1];
      const z_e  = elev[rowCur + c + 1];
      const z_sw = elev[rowNext + c - 1];
      const z_s  = elev[rowNext + c];
      const z_se = elev[rowNext + c + 1];

      const dzdx = (z_ne + 2 * z_e + z_se - (z_nw + 2 * z_w + z_sw)) * inv8Cell;
      const dzdy = (z_sw + 2 * z_s + z_se - (z_nw + 2 * z_n + z_ne)) * inv8Cell;

      const slopeRad = Math.atan(Math.hypot(dzdx, dzdy));
      slopes[rowCur + c] = slopeRad * rad2deg;
    }
  }
  return slopes;
}

function smoothGradientsAlongTrack(route: { distanceM: number; gradientPct: number }[], windowM: number): Float32Array {
  const n = route.length;
  const smoothed = new Float32Array(n);
  const halfWindow = windowM / 2;

  let left = 0;
  let right = 0;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const d = route[i].distanceM;
    while (right < n && route[right].distanceM <= d + halfWindow) {
      sum += route[right].gradientPct;
      count++;
      right++;
    }
    while (left < right && route[left].distanceM < d - halfWindow) {
      sum -= route[left].gradientPct;
      count--;
      left++;
    }
    smoothed[i] = count > 0 ? sum / count : route[i].gradientPct;
  }

  return smoothed;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-pente.ts')) {
  const quick = process.argv.includes('--quick');
  runSlopeBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
