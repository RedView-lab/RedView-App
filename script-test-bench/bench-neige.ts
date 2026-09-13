/**
 * RedView Test-Bench : Neige (Snow Physics & University Nivology)
 * 
 * Benchmarks du moteur nivologique 7 phases (López-Moreno, SnowSlide, Winstral Sx, Tarboton D-inf) :
 * 1. Échantillonnage & Rééchantillonnage (downsampleBox & upsampleBilinear)
 * 2. Lissage Gaussien Séparable (gaussianSmoothLight)
 * 3. Indice d'abri au vent de Winstral multi-directions (computeShelterIndexMulti)
 * 4. Routage de flux D-infinity & Accumulation (Tarboton)
 * 5. Pipeline complet de redistribution 7 phases (computeSnowRedistribution)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticDemGrid, generateSyntheticSnowGrid } from './core/synthetic-data.ts';
import {
  computeSnowRedistribution,
  type RedistributeInput,
} from '../src/features/snow/lib/redistribute.ts';
import {
  downsampleBox,
  upsampleBilinear,
  gaussianSmoothLight,
  computeShelterIndexMulti,
  computeDinfFlow,
  computeFlowAccumulationDinf,
} from '../src/features/snow/lib/redistributeTerrainMath.ts';
import { DEFAULT_SNOW_CONFIG } from '../src/features/snow/lib/config.ts';

export async function runSnowBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Neige (Snow Physics & Nivologie)');
  const iterations = options.quick ? 3 : 10;

  // Préparation du terrain alpin (256x256)
  const terrainSize: [number, number] = [5000, 5000]; // 5km x 5km
  const terrainOrigin: [number, number] = [980000, 6450000];
  const hm256 = generateSyntheticDemGrid(256, 256, 800, 3400);

  // Grille AROME 32x32
  const aromeW = 32;
  const aromeH = 32;
  const aromeDem = downsampleBox(hm256, 256, 256, aromeW, aromeH);
  const aromeSnow = generateSyntheticSnowGrid(aromeW, aromeH, aromeDem);
  const aromeBounds: [number, number, number, number] = [
    terrainOrigin[0],
    terrainOrigin[1],
    terrainOrigin[0] + terrainSize[0],
    terrainOrigin[1] + terrainSize[1],
  ];

  const fullInput: RedistributeInput = {
    heightmap: hm256,
    terrainW: 256,
    terrainH: 256,
    terrainOrigin,
    terrainSize,
    aromeData: aromeSnow,
    aromeW,
    aromeH,
    aromeBounds,
    config: {
      ...DEFAULT_SNOW_CONFIG,
      maxResolution: 128, // Résolution de travail standard
      gravityIterations: 15,
    },
  };

  // --- BENCHMARK 1 : Upsampling bilinéaire (AROME 32x32 -> Terrain 256x256) ---
  suite.measureSync(
    {
      name: 'Upsampling Bilinéaire (32x32 → 256x256)',
      category: 'snow-sampling',
      iterations: iterations * 4,
      regressionThresholdP95Ms: 8.0,
      itemsProcessedPerOp: 256 * 256,
    },
    () => upsampleBilinear(aromeSnow, aromeW, aromeH, aromeBounds, 256, 256, terrainOrigin, terrainSize),
  );

  // --- BENCHMARK 2 : Lissage Gaussien Séparable 1D x 2 (sigma=2.0) ---
  suite.measureSync(
    {
      name: 'Lissage Gaussien Séparable (256x256, σ=2.0)',
      category: 'snow-gaussian',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 16.0,
      itemsProcessedPerOp: 256 * 256,
    },
    () => gaussianSmoothLight(hm256, 256, 256, 2.0),
  );

  // --- BENCHMARK 3 : Indice d'abri au vent Winstral multi-directions (5 angles) ---
  const hm128 = downsampleBox(hm256, 256, 256, 128, 128);
  suite.measureSync(
    {
      name: "Indice d'Abri Winstral Sx (128x128, 5 dirs)",
      category: 'snow-winstral',
      iterations,
      regressionThresholdP95Ms: 18.0,
      itemsProcessedPerOp: 128 * 128 * 5,
    },
    () => computeShelterIndexMulti(hm128, 128, 128, 39.0, 270),
  );

  // --- BENCHMARK 4 : Routage & Accumulation D-infinity (Tarboton) ---
  suite.measureSync(
    {
      name: 'Routage de flux D-infinity & Accumulation (128x128)',
      category: 'snow-dinf-flow',
      iterations,
      regressionThresholdP95Ms: 30.0,
      itemsProcessedPerOp: 128 * 128,
    },
    () => {
      const flow = computeDinfFlow(hm128, 128, 128, 39.0);
      return computeFlowAccumulationDinf(flow, hm128);
    },
  );

  // --- BENCHMARK 5 : Pipeline Complet 7 Phases (computeSnowRedistribution) ---
  suite.measureSync(
    {
      name: 'Pipeline 7 Phases Universitaire (SnowSlide + Eolien)',
      category: 'snow-full-pipeline',
      iterations: Math.max(2, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 300.0,
    },
    () => computeSnowRedistribution(fullInput),
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    "Calcul de l'indice d'abri Winstral Sx : complexité O(W × H × N_steps × N_dirs). Au-delà de 256x256, goulot CPU sévère (>500ms).",
  );
  suite.addRegressionRisk(
    'Instabilité gravitationnelle de SnowSlide si frictionAngleDeg < 30° : risque de transfert infini entre cellules en boucle fermée.',
  );
  suite.addRecommendation(
    'Exécuter obligatoirement computeSnowRedistribution dans un Web Worker d’arrière-plan (déjà supporté via redistributeWorker.ts).',
  );
  suite.addRecommendation(
    'Sous-échantillonner la grille terrain à 128x128 pour le calcul physique puis sur-échantillonner le résultat (gain de 400% sur le temps de calcul).',
  );

  return suite;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-neige.ts')) {
  const quick = process.argv.includes('--quick');
  runSnowBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
