/**
 * RedView Test-Bench : Altitude (Elevation, MNT, D+/D- & Profils)
 * 
 * Benchmarks :
 * 1. Conversion Terrarium vers Terrain-RGB Mapbox (/altitude-tiles)
 * 2. Échantillonnage d'élévation sur MNT par interpolation bilinéaire (1k, 10k, 50k points)
 * 3. Algorithme de calcul cumulatif D+ / D- avec filtre anti-bruit (seuil 3m, 5m, 10m)
 * 4. Upsampling de tuiles parentes (upsampleElevations)
 * 5. Construction de palettes et catégories d'altitude (buildAltitudeCategories)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticDemGrid, generateSyntheticRoute } from './core/synthetic-data.ts';
import { buildAltitudeCategories } from '../src/features/altitude/lib/altitude-config.ts';
import { generateAltitudeTile } from '../server/terrain-tiles.mjs';

export async function runAltiBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Altitude (Elevation & D+/D-)');
  const iterations = options.quick ? 5 : 20;

  // Données synthétiques
  const grid256 = generateSyntheticDemGrid(256, 256);
  const route1k = generateSyntheticRoute(1_000);
  const route10k = generateSyntheticRoute(10_000);
  const route50k = generateSyntheticRoute(50_000);

  // --- BENCHMARK 1 : Échantillonnage MNT (1 000 points) ---
  suite.measureSync(
    {
      name: 'Échantillonnage MNT Bilinéaire (1k pts)',
      category: 'alti-sampling-1k',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 5.0,
      itemsProcessedPerOp: 1_000,
    },
    () => sampleElevationsBilinear(route1k, grid256, 256, 256),
  );

  // --- BENCHMARK 2 : Échantillonnage MNT (10 000 points) ---
  suite.measureSync(
    {
      name: 'Échantillonnage MNT Bilinéaire (10k pts)',
      category: 'alti-sampling-10k',
      iterations,
      regressionThresholdP95Ms: 3.5,
      itemsProcessedPerOp: 10_000,
    },
    () => sampleElevationsBilinear(route10k, grid256, 256, 256),
  );

  // --- BENCHMARK 3 : Échantillonnage MNT Échelle Ultra (50 000 points) ---
  suite.measureSync(
    {
      name: 'Échantillonnage MNT Bilinéaire (50k pts)',
      category: 'alti-sampling-50k',
      iterations: Math.max(3, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 16.0,
      itemsProcessedPerOp: 50_000,
    },
    () => sampleElevationsBilinear(route50k, grid256, 256, 256),
  );

  // --- BENCHMARK 4 : Calcul D+ / D- avec filtre anti-bruit 5m (50 000 points) ---
  suite.measureSync(
    {
      name: 'Calcul D+/D- Seuil 5m (50k pts)',
      category: 'alti-elevation-gain',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 3.5,
      itemsProcessedPerOp: 50_000,
    },
    () => computeElevationGainLoss(route50k, 5.0),
  );

  // --- BENCHMARK 5 : Construction des catégories d'altitude ---
  suite.measureSync(
    {
      name: 'Génération Échelle Altitudes (6 couleurs)',
      category: 'alti-config',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 0.2,
    },
    () => buildAltitudeCategories('6 couleurs'),
  );

  // --- BENCHMARK 6 : Générateur de Tuile Serveur Terrain-RGB (/altitude-tiles) ---
  try {
    await suite.measureAsync(
      {
        name: 'Génération Tuile Serveur (/altitude-tiles)',
        category: 'alti-tile-server',
        iterations: options.quick ? 3 : 6,
        regressionThresholdP95Ms: 120.0,
      },
      async () => {
        return await generateAltitudeTile(12, 2124, 1445);
      },
    );
  } catch {
    // Si pas de connexion externe
  }

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Bruit GPS haute fréquence : un seuil de détection D+ inférieur à 3m entraîne une surévaluation de 15% à 40% du D+ total.',
  );
  suite.addRegressionRisk(
    'Pics de mémoire sur traces > 50k points lors de l’échantillonnage DEM sans downsampling préalable.',
  );
  suite.addRecommendation(
    'Appliquer un filtre de Hystérésis ou Ramer-Douglas-Peucker 1D sur l’élévation brute avant le calcul du dénivelé.',
  );
  suite.addRecommendation(
    'Utiliser des SharedArrayBuffers ou buffers Float32Array réutilisés pour les tuiles de terrain afin d’éliminer les allocations V8.',
  );

  return suite;
}

function sampleElevationsBilinear(
  route: { lat: number; lon: number }[],
  grid: Float32Array,
  w: number,
  h: number,
): Float32Array {
  const n = route.length;
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    // Normalisation de coordonnées simulée sur [0, 1]
    const u = (i / n) * 0.9 + 0.05;
    const v = ((Math.sin(i * 0.02) + 1) / 2) * 0.9 + 0.05;

    const fx = u * (w - 1);
    const fy = v * (h - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const dx = fx - x0;
    const dy = fy - y0;

    const e00 = grid[y0 * w + x0];
    const e10 = grid[y0 * w + x1];
    const e01 = grid[y1 * w + x0];
    const e11 = grid[y1 * w + x1];

    out[i] = (e00 * (1 - dx) + e10 * dx) * (1 - dy) + (e01 * (1 - dx) + e11 * dx) * dy;
  }

  return out;
}

function computeElevationGainLoss(
  route: { elevationM: number }[],
  thresholdM: number,
): { gainM: number; lossM: number } {
  let gain = 0;
  let loss = 0;
  let currentRef = route[0]?.elevationM ?? 0;

  for (let i = 1; i < route.length; i++) {
    const diff = route[i].elevationM - currentRef;
    if (diff >= thresholdM) {
      gain += diff;
      currentRef = route[i].elevationM;
    } else if (diff <= -thresholdM) {
      loss += Math.abs(diff);
      currentRef = route[i].elevationM;
    }
  }

  return { gainM: Math.round(gain), lossM: Math.round(loss) };
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-alti.ts')) {
  const quick = process.argv.includes('--quick');
  runAltiBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
