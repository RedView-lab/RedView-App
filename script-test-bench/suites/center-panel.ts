/**
 * RedView Test-Bench : Center Panel (graphique d'analyse multi-axes)
 *
 * Mesure le VRAI code des séries du graphique (src/features/centerPanel/components/chart) :
 * 1. Séries tirées de la trace (Altitude, Inclinaison) à froid (nouvelle trace,
 *    caches vides) et à chaud (même trace, ce que le graphique refait à chaque
 *    rendu qui recalcule ses nœuds).
 * 2. Séries « moyennes sur 500 m » (Vitesse moyenne) d'un ultra de 1 200 km
 *    (100 000 points de prédiction), à froid.
 * 3. Budget de points LTTB (fitChartPointBudget : 24 000 → 2 000), domaine Y
 *    (computeDomain), curseur de survol (locateRoutePointAtX × 1 000).
 * 4. Séries météo (Température en distance, Pluie en heure).
 * Jusqu'au 2026-10-06 ce bench lisait `.points` sur un tableau (LTTB et domaine
 * mesurés sur un tableau vide), passait la prédiction à la place de x au
 * curseur (null immédiat) et mesurait une copie locale du LTTB.
 */
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import {
  buildSeriesFromPrediction,
  computeDomain,
  locateRoutePointAtX,
  type ChartPoint,
  type RouteChartPoint,
} from '../../src/features/centerPanel/components/chart/series.ts';
import { fitChartPointBudget } from '../../src/features/centerPanel/components/chart/seriesPredictionMath.ts';
import type { PredictionResult } from '../../src/features/fitPredictor/types.ts';
import type { RouteWeatherDataset } from '../../src/features/weather/lib/routeWeather.ts';

function routeAndPrediction(pointCount: number): { routePoints: RouteChartPoint[]; prediction: PredictionResult } {
  const routePoints = Array.from({ length: pointCount }, (_, index) => {
    const wave = Math.sin(index / 90) * 35 + Math.sin(index / 17) * 4;
    return {
      lat: 45 + index * 0.00008,
      lon: 6 + index * 0.00011,
      distanceM: index * 12,
      elevationM: 700 + wave + index * 0.04,
      gradientPct: Math.cos(index / 40) * 8,
    };
  });
  const points = routePoints.map((point, index) => ({
    distance_m: point.distanceM,
    elevation_m: point.elevationM,
    gradient_pct: point.gradientPct,
    predicted_speed_kmh: 22 + Math.sin(index / 120) * 6,
    predicted_power_w: 210 + Math.cos(index / 75) * 55,
    elapsed_time_s: index * 2.2,
    segment_time_s: 2.2,
  }));
  const prediction = {
    total_time_s: points[points.length - 1]!.elapsed_time_s,
    riding_time_s: points[points.length - 1]!.elapsed_time_s,
    stop_time_s: 0,
    total_distance_m: routePoints[routePoints.length - 1]!.distanceM,
    avg_speed_kmh: 24.5,
    elevation_gain_m: 1650,
    elevation_loss_m: 1620,
    segments: [],
    points,
    rider_profile: {
      ftp_w: 270, mass_kg: 76, rider_weight_kg: 68, bike_weight_kg: 8, wkg: 3.5, cda: 0.31, crr: 0.0045, has_power: true,
    },
  } as unknown as PredictionResult;
  return { routePoints, prediction };
}

export async function runCenterPanelBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Center Panel (Graphiques Multi-Axes & Timeline)');
  const iterations = options.quick ? 5 : 20;
  const { routePoints, prediction } = routeAndPrediction(24_000);
  const ultra = routeAndPrediction(100_000);
  // Copies superficielles : les caches des séries sont indexés par objet.
  const fresh = (data: { routePoints: RouteChartPoint[]; prediction: PredictionResult }) => ({
    routePoints: data.routePoints.slice(),
    prediction: { ...data.prediction },
  });

  // --- Séries tirées de la trace ---
  suite.measureSync(
    {
      name: 'Série Altitude (heure, 24k pts) — froid',
      category: 'chart-series',
      iterations,
      regressionThresholdP95Ms: 30.0,
      itemsProcessedPerOp: 24_000,
    },
    () => {
      const d = fresh({ routePoints, prediction });
      return buildSeriesFromPrediction(d.prediction, 'Altitude', 'heure', d.routePoints, 'gpx', '08:00');
    },
  );
  const altitude = buildSeriesFromPrediction(prediction, 'Altitude', 'heure', routePoints, 'gpx', '08:00') ?? [];
  suite.measureSync(
    {
      name: 'Série Altitude (heure, 24k pts) — chaud (cache)',
      category: 'chart-series',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.0,
    },
    () => buildSeriesFromPrediction(prediction, 'Altitude', 'heure', routePoints, 'gpx', '08:00'),
  );
  suite.measureSync(
    {
      name: 'Série Inclinaison (temps, 24k pts) — froid',
      category: 'chart-series',
      iterations,
      regressionThresholdP95Ms: 30.0,
      itemsProcessedPerOp: 24_000,
    },
    () => {
      const d = fresh({ routePoints, prediction });
      return buildSeriesFromPrediction(d.prediction, 'Inclinaison (%)', 'temps', d.routePoints, 'gpx', '08:00');
    },
  );
  const speed = buildSeriesFromPrediction(prediction, 'Vitesse', 'distance', routePoints, 'gpx', '08:00') ?? [];
  suite.measureSync(
    {
      name: 'Série Vitesse (distance, 24k pts) — froid',
      category: 'chart-series',
      iterations,
      regressionThresholdP95Ms: 20.0,
      itemsProcessedPerOp: 24_000,
    },
    () => {
      const d = fresh({ routePoints, prediction });
      return buildSeriesFromPrediction(d.prediction, 'Vitesse', 'distance', d.routePoints, 'gpx', '08:00');
    },
  );
  suite.measureSync(
    {
      name: 'Série Vitesse moyenne (temps, ultra 1 200 km) — froid',
      category: 'chart-series-average',
      iterations: Math.max(3, iterations >> 2),
      regressionThresholdP95Ms: 80.0,
      itemsProcessedPerOp: 100_000,
    },
    () => {
      const d = fresh(ultra);
      return buildSeriesFromPrediction(d.prediction, 'Vitesse moyenne', 'temps', d.routePoints, 'brouter', '06:00');
    },
  );

  // --- Budget de points, domaine, curseur ---
  const raw: ChartPoint[] = prediction.points.map((p) => ({ x: p.distance_m / 1000, y: p.elevation_m }));
  suite.measureSync(
    {
      name: 'LTTB fitChartPointBudget (24k → 2 000 pts)',
      category: 'chart-downsampling',
      iterations: iterations * 4,
      regressionThresholdP95Ms: 3.0,
      itemsProcessedPerOp: raw.length,
    },
    () => fitChartPointBudget(raw),
  );
  suite.measureSync(
    {
      name: 'Domaine Y (computeDomain, 2 séries)',
      category: 'chart-domain',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.0,
      itemsProcessedPerOp: altitude.length + speed.length,
    },
    () => computeDomain([altitude, speed]),
  );
  const totalKm = prediction.total_distance_m / 1000;
  const totalH = prediction.total_time_s / 3600;
  for (const xMode of ['distance', 'heure'] as const) {
    suite.measureSync(
      {
        name: `Curseur de survol (${xMode}, 1k requêtes)`,
        category: 'chart-cursor',
        iterations: iterations * 5,
        regressionThresholdP95Ms: 2.0,
        itemsProcessedPerOp: 1000,
      },
      () => {
        let found = 0;
        for (let i = 0; i < 1000; i++) {
          const x = xMode === 'distance' ? (i / 1000) * totalKm : 8 + (i / 1000) * totalH;
          if (locateRoutePointAtX(routePoints, prediction, xMode, x, '08:00')) found++;
        }
        if (found < 990) throw new Error(`[bench-chart] curseur : ${found}/1000 points trouvés`);
        return found;
      },
    );
  }

  // --- Séries météo ---
  const hours = 48;
  const mockWeatherDataset: RouteWeatherDataset = {
    itineraryId: 'bench-route',
    signature: 'bench-sig',
    startDate: '2026-09-13',
    startTime: '08:00',
    fetchedAt: Date.now(),
    samples: [0, 144_000, 288_000].map((distanceM) => ({
      lat: 45.0,
      lng: 6.0,
      distanceM,
      elevationM: 700,
      hourly: {
        time: Array.from({ length: hours }, (_, h) => `2026-09-${String(13 + Math.floor(h / 24)).padStart(2, '0')}T${String(h % 24).padStart(2, '0')}:00`),
        temperature_2m: Array.from({ length: hours }, (_, h) => 18 + Math.sin(h / 3) * 6),
        apparent_temperature: Array.from({ length: hours }, (_, h) => 17 + Math.sin(h / 3) * 6),
        precipitation: Array.from({ length: hours }, (_, h) => Math.max(0, Math.sin(h / 5) * 2)),
        wind_speed_10m: Array.from({ length: hours }, () => 12),
        cloud_cover: Array.from({ length: hours }, () => 40),
        relative_humidity_2m: Array.from({ length: hours }, () => 70),
        sunshine_duration: Array.from({ length: hours }, () => 30),
      },
    })),
  };
  suite.measureSync(
    {
      name: 'Série Météo Température (distance, 24k pts)',
      category: 'chart-weather-series',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 24_000,
    },
    () => buildSeriesFromPrediction(prediction, 'Température', 'distance', routePoints, 'gpx', '08:00', undefined, 0, mockWeatherDataset),
  );
  suite.measureSync(
    {
      name: 'Série Météo Pluie (heure, 24k pts)',
      category: 'chart-weather-series',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 24_000,
    },
    () => buildSeriesFromPrediction(prediction, 'Pluie (mm)', 'heure', routePoints, 'gpx', '08:00', undefined, 0, mockWeatherDataset),
  );

  suite.addRegressionRisk(
    'Séries « moyennes sur 500 m » : un balayage de toute la prédiction par intervalle coûtait 0,2-1 s sur un ultra (corrigé le 2026-10-06, bissection).',
  );
  suite.addRegressionRisk(
    'Le cache des séries est indexé par objet (trace, prédiction) : une copie à chaque rendu le rend inutile.',
  );
  suite.addRecommendation('Le graphique recalcule axe 1, axe 2 et altitude de chaque itinéraire visible à chaque zoom (detailZoom).');

  return suite;
}

// Standalone execution
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/center-panel.ts')) {
  const quick = process.argv.includes('--quick');
  runCenterPanelBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
