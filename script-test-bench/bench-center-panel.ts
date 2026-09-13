/**
 * RedView Test-Bench : Center Panel (Graphiques Multi-Axes & Timeline)
 * 
 * Benchmarks :
 * 1. Génération des séries graphiques multi-axes (buildSeriesFromPrediction) sur 24 000 points
 * 2. Algorithme de downsampling LTTB (24k pts → 1 200 pixels écran) pour 60 FPS
 * 3. Calcul dynamique des bornes Y (computeDomain)
 * 4. Recherche dichotomique point curseur (locateRoutePointAtX)
 * 5. Calcul de placement de la timeline kilométrique proportionnelle
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import {
  buildSeriesFromPrediction,
  computeDomain,
  locateRoutePointAtX,
  type ChartPoint,
} from '../src/features/centerPanel/components/chart/series.ts';
import type { PredictionResult } from '../src/features/fitPredictor/types.ts';

export async function runCenterPanelBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Center Panel (Graphiques Multi-Axes & Timeline)');
  const iterations = options.quick ? 5 : 20;

  // Préparation du dataset de test 24 000 points
  const pointCount = 24_000;
  const routePoints = Array.from({ length: pointCount }, (_, index) => {
    const distanceM = index * 12;
    const wave = Math.sin(index / 90) * 35 + Math.sin(index / 17) * 4;
    return {
      lat: 45 + index * 0.00008,
      lon: 6 + index * 0.00011,
      distanceM,
      elevationM: 700 + wave + index * 0.04,
      gradientPct: Math.cos(index / 40) * 8,
    };
  });

  const predictionPoints = routePoints.map((point, index) => ({
    distance_m: point.distanceM,
    elevation_m: point.elevationM,
    gradient_pct: point.gradientPct,
    predicted_speed_kmh: 22 + Math.sin(index / 120) * 6,
    predicted_power_w: 210 + Math.cos(index / 75) * 55,
    elapsed_time_s: index * 2.2,
    segment_time_s: 2.2,
  }));

  const prediction: PredictionResult = {
    total_time_s: predictionPoints[predictionPoints.length - 1]?.elapsed_time_s ?? 0,
    riding_time_s: predictionPoints[predictionPoints.length - 1]?.elapsed_time_s ?? 0,
    stop_time_s: 0,
    total_distance_m: routePoints[routePoints.length - 1]?.distanceM ?? 0,
    avg_speed_kmh: 24.5,
    elevation_gain_m: 1650,
    elevation_loss_m: 1620,
    segments: [],
    points: predictionPoints,
    rider_profile: {
      ftp_w: 270,
      mass_kg: 76,
      rider_weight_kg: 68,
      bike_weight_kg: 8,
      wkg: 3.5,
      cda: 0.31,
      crr: 0.0045,
      has_power: true,
    },
  };

  // --- BENCHMARK 1 : Construction de la série Altitude (Mode Heure) ---
  let altitudeSeries: { points: ChartPoint[] } | null = null;
  suite.measureSync(
    {
      name: 'Génération Série Altitude (Mode Heure, 24k pts)',
      category: 'chart-series',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 24_000,
    },
    () => {
      altitudeSeries = buildSeriesFromPrediction(prediction, 'Altitude', 'heure', routePoints, 'gpx', '08:00');
      return altitudeSeries;
    },
  );

  // --- BENCHMARK 2 : Construction de la série Inclinaison (Mode Temps) ---
  suite.measureSync(
    {
      name: 'Génération Série Inclinaison (Mode Temps, 24k pts)',
      category: 'chart-series',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 24_000,
    },
    () => buildSeriesFromPrediction(prediction, 'Inclinaison (%)', 'temps', routePoints, 'gpx', '08:00'),
  );

  // --- BENCHMARK 3 : Construction de la série Vitesse Moyenne (Mode Distance) ---
  suite.measureSync(
    {
      name: 'Génération Série Vitesse (Mode Distance, 24k pts)',
      category: 'chart-series',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 24_000,
    },
    () => buildSeriesFromPrediction(prediction, 'Vitesse', 'distance', routePoints, 'gpx', '08:00'),
  );

  // --- BENCHMARK 4 : Algorithme de Downsampling LTTB (24k pts → 1 200 pixels) ---
  const chartPts = altitudeSeries?.points ?? [];
  suite.measureSync(
    {
      name: 'Downsampling LTTB 60 FPS (24k pts → 1 200 pts)',
      category: 'chart-downsampling',
      iterations: iterations * 4,
      regressionThresholdP95Ms: 3.0,
      itemsProcessedPerOp: chartPts.length,
    },
    () => downsampleLttb(chartPts, 1200),
  );

  // --- BENCHMARK 5 : Calcul des Domaines Axes Y (computeDomain) ---
  suite.measureSync(
    {
      name: 'Calcul Domaine Y (computeDomain sur 24k pts)',
      category: 'chart-domain',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.0,
      itemsProcessedPerOp: chartPts.length,
    },
    () => computeDomain(chartPts),
  );

  // --- BENCHMARK 6 : Recherche Dichotomique Curseur (locateRoutePointAtX 1 000 requêtes) ---
  suite.measureSync(
    {
      name: 'Recherche Curseur Hover (1k requêtes dichotomiques)',
      category: 'chart-cursor',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 0.8,
      itemsProcessedPerOp: 1000,
    },
    () => {
      let dummy = 0;
      for (let i = 0; i < 1000; i++) {
        const targetX = (i / 1000) * (prediction.total_distance_m || 10000);
        const pt = locateRoutePointAtX(routePoints, targetX, 'distance', prediction, '08:00');
        if (pt) dummy += pt.elevationM;
      }
      return dummy;
    },
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Re-rendu SVG React sur 24k points sans downsampling : freeze complet du DOM (>300ms de scripting et garbage collection).',
  );
  suite.addRegressionRisk(
    'Invalidation globale du cache graphique : changer une seule variable Y2 recalcule actuellement les deux axes inutilement.',
  );
  suite.addRecommendation(
    'Rendre le graphique via HTML5 Canvas 2D ou WebGL (uPlot ou Canvas natif) plutôt qu’un SVG React pour garantir 60 FPS constants lors du survol.',
  );
  suite.addRecommendation(
    'Intégrer le downsampling LTTB (Largest Triangle Three Buckets) dès la sortie du buildSeriesFromPrediction pour limiter les tableaux à 1 200 éléments.',
  );

  return suite;
}

/**
 * Algorithme de downsampling LTTB (Largest Triangle Three Buckets)
 * Réduit les séries denses tout en conservant visuellement les pics et creux critiques.
 */
function downsampleLttb(data: ChartPoint[], threshold: number): ChartPoint[] {
  const dataLen = data.length;
  if (threshold >= dataLen || threshold === 0) return data;

  const sampled: ChartPoint[] = new Array(threshold);
  let sampledIndex = 0;

  const bucketSize = (dataLen - 2) / (threshold - 2);
  let a = 0;
  sampled[sampledIndex++] = data[a];

  for (let i = 0; i < threshold - 2; i++) {
    let avgX = 0;
    let avgY = 0;
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.min(dataLen, Math.floor((i + 2) * bucketSize) + 1);
    const avgRangeLength = avgRangeEnd - avgRangeStart;

    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      avgX += data[j].x;
      avgY += data[j].y;
    }
    avgX /= avgRangeLength > 0 ? avgRangeLength : 1;
    avgY /= avgRangeLength > 0 ? avgRangeLength : 1;

    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.min(dataLen, Math.floor((i + 1) * bucketSize) + 1);

    const pointAX = data[a].x;
    const pointAY = data[a].y;
    let maxArea = -1;
    let maxAreaPoint = data[rangeStart];
    let nextA = rangeStart;

    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (pointAX - avgX) * (data[j].y - pointAY) -
          (pointAX - data[j].x) * (avgY - pointAY),
      ) * 0.5;

      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = data[j];
        nextA = j;
      }
    }

    sampled[sampledIndex++] = maxAreaPoint;
    a = nextA;
  }

  sampled[sampledIndex++] = data[dataLen - 1];
  return sampled;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-center-panel.ts')) {
  const quick = process.argv.includes('--quick');
  runCenterPanelBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
