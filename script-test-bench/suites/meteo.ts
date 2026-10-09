/**
 * RedView Test-Bench : Météorologie (Weather)
 *
 * Benchmarks (vrai code de l'app) :
 * 1. Météo le long de la trace : réponse Open-Meteo multi-points d'une trace
 *    de 1 200 km (26 stations × 16 jours × 7 variables) lue par
 *    fetchRouteWeatherDataset (fetch simulé, une trace différente par
 *    itération : le jeu de données est sinon servi par son cache).
 * 2. Interpolation spatio-temporelle aux 24 000 points du graphique
 *    (getRouteWeatherAtDistanceAndTime : encadrement des stations, heure,
 *    correction d'altitude).
 * 3. Grille de vent régulière (computeWindGrid) pour le GPU.
 * 4. Tuile du radar européen EUMETNET OPERA dessinée côté serveur
 *    (renderOperaTile : en-tête et tuiles du COG, reprojection, palette, PNG),
 *    sur un COG synthétique servi en mémoire, une image neuve par itération.
 * 5. Latence HTTP /api/weather si un serveur local répond.
 * Jusqu'au 2026-10-06, 1 et 2 mesuraient des copies écrites dans le bench
 * (JSON.parse d'une station, interpolation simplifiée).
 */
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { computeWindGrid } from '../../src/features/weather/lib/wind-grid.ts';
import {
  fetchRouteWeatherDataset,
  getRouteWeatherAtDistanceAndTime,
  type RouteWeatherDataset,
} from '../../src/features/weather/lib/routeWeather.ts';
import type { RouteChartPoint } from '../../src/features/centerPanel/components/chart/seriesCommon.ts';
import { renderOperaTile } from '../../server/lib/opera-radar.mjs';
import { buildFixtureCog, fixtureFetch } from '../../server/lib/__tests__/operaFixture.ts';

const ROUTE_KM = 1200;
const FORECAST_DAYS = 16;
const HOURLY_VARS = [
  'temperature_2m', 'apparent_temperature', 'precipitation', 'wind_speed_10m',
  'cloud_cover', 'relative_humidity_2m', 'sunshine_duration',
] as const;

/** Trace de 1 200 km, un point tous les 600 m. */
function syntheticRoute(): RouteChartPoint[] {
  const n = (ROUTE_KM * 1000) / 600 + 1;
  return Array.from({ length: n }, (_, i) => ({
    lat: 45 + i * 0.0045,
    lon: 6 + 0.4 * Math.sin(i / 300),
    distanceM: i * 600,
    elevationM: 800 + 700 * Math.sin(i / 90),
  }));
}

/** Réponse Open-Meteo (tableau, une entrée par station), heures murales locales. */
function openMeteoBody(stations: number, startDate: string): string {
  const [y, m, d] = startDate.split('-').map(Number);
  const time: string[] = [];
  for (let h = 0; h < FORECAST_DAYS * 24; h++) {
    const t = new Date(y, m - 1, d, h);
    time.push(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}T${String(t.getHours()).padStart(2, '0')}:00`);
  }
  return JSON.stringify(Array.from({ length: stations }, (_, s) => ({
    latitude: 45 + s * 0.2,
    longitude: 6,
    elevation: 900,
    hourly: Object.fromEntries([
      ['time', time],
      ...HOURLY_VARS.map((v, k) => [v, time.map((_, h) => Math.round((10 + 8 * Math.sin((h + k + s) / 7)) * 10) / 10)]),
    ]),
  })));
}

function localDateIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export async function runMeteoBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Météo (Weather & Radar)');
  const iterations = options.quick ? 5 : 20;

  const route = syntheticRoute();
  const startDate = localDateIso(new Date());
  const body = openMeteoBody(26, startDate);

  const samplePalette = 'gradient:2DBF8C_0_5:7CD95F_5_15:FFD800_15_25:FF0000_25_50';

  // --- BENCHMARK 1 : réponse Open-Meteo de la trace (fetchRouteWeatherDataset) ---
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  let dataset: RouteWeatherDataset | null = null;
  let variant = 0;
  try {
    await suite.measureAsync(
      {
        name: 'Météo trace : réponse Open-Meteo 26 stations × 16 j',
        category: 'meteo-parsing',
        iterations,
        regressionThresholdP95Ms: 40.0,
        itemsProcessedPerOp: 26 * FORECAST_DAYS * 24 * HOURLY_VARS.length,
      },
      async () => {
        // Une trace différente à chaque fois (dernier point déplacé de 10 m).
        const points = route.slice();
        const last = points[points.length - 1];
        points[points.length - 1] = { ...last, distanceM: (last.distanceM ?? 0) + 10 * ++variant };
        dataset = await fetchRouteWeatherDataset('bench', points, startDate, '06:00', undefined, { rideDurationHours: 60 });
        if (!dataset || dataset.samples.length !== 26) throw new Error('[bench-meteo] jeu de données météo incomplet');
        return dataset;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- BENCHMARK 2 : interpolation aux 24 000 points du graphique ---
  const chartPoints = 24_000;
  const rideSeconds = 60 * 3600;
  suite.measureSync(
    {
      name: 'Météo trace : interpolation 24k pts (getRouteWeatherAtDistanceAndTime)',
      category: 'meteo-interpolation',
      iterations,
      regressionThresholdP95Ms: 30.0,
      itemsProcessedPerOp: chartPoints,
    },
    () => {
      const ds = dataset as RouteWeatherDataset;
      let sum = 0;
      for (let i = 0; i < chartPoints; i++) {
        const f = i / (chartPoints - 1);
        const v = getRouteWeatherAtDistanceAndTime(ds, f * ROUTE_KM * 1000, f * rideSeconds, 800 + 700 * Math.sin(i / 90));
        if (v) sum += v.temperature;
      }
      return sum;
    },
  );

  // --- BENCHMARK 3 : Grille régulière de vent GPU (computeWindGrid) ---
  suite.measureSync(
    {
      name: 'Calcul Grille de Vent GPU (Zoom 9)',
      category: 'meteo-wind-grid',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 2.0,
    },
    () => {
      const bounds = { north: 46.2, south: 44.8, east: 7.2, west: 5.6 };
      const viewport = bounds;
      return computeWindGrid(bounds, viewport, 9);
    },
  );

  // --- BENCHMARK 4 : tuile radar OPERA (renderOperaTile), image neuve à chaque itération ---
  const operaFetch = globalThis.fetch;
  globalThis.fetch = fixtureFetch(buildFixtureCog(), []) as typeof fetch;
  let operaFrame = 0;
  try {
    await suite.measureAsync(
      {
        name: 'Tuile radar OPERA 512x512 (COG → reprojection → palette → PNG)',
        category: 'meteo-radar-opera',
        iterations,
        regressionThresholdP95Ms: 120.0,
      },
      async () => {
        operaFrame += 1;
        return renderOperaTile(`20261009T${String(1000 + operaFrame).slice(-4)}`, 6, 32, 22, samplePalette);
      },
    );
  } finally {
    globalThis.fetch = operaFetch;
  }

  // --- BENCHMARK 5 : Test Live HTTP si disponible ---
  const liveTarget = process.env.WEATHER_API_URL || 'http://localhost:3000/api/weather';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const resp = await fetch(`${liveTarget}?lat=45.92&lng=6.86`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (resp.ok) {
      await suite.measureAsync(
        {
          name: 'Live HTTP /api/weather Latency',
          category: 'meteo-network',
          iterations: options.quick ? 3 : 5,
        },
        async () => {
          const r = await fetch(`${liveTarget}?lat=45.92&lng=6.86`);
          return await r.json();
        },
      );
    }
  } catch {
    // Serveur local non lancé, test synthétique offline uniquement
  }

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Tuile radar dessinée sur le thread Node.js : décompression des tuiles du COG et reprojection de 262 144 pixels à la première demande de chaque tuile.',
  );
  suite.addRegressionRisk(
    'Taille mémoire des grilles de vent : fuite potentielle si les textures GPU ne sont pas libérées lors du pan.',
  );
  suite.addRecommendation(
    'Si la charge radar grandit : préparer les tuiles des zooms 3 à 7 de chaque nouvelle image OPERA dans un worker_thread au lieu de les dessiner à la demande.',
  );

  return suite;
}

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/meteo.ts')) {
  const quick = process.argv.includes('--quick');
  runMeteoBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
