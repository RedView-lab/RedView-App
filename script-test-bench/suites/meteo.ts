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
 * 4. Recoloration des tuiles radar RainViewer côté serveur (recolorRadarPng).
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
import { recolorRadarPng } from '../../server/lib/radar-recolor.mjs';
import { deflateSync, crc32 } from 'node:zlib';

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

  // Un PNG 512x512 valide pour la recoloration radar RainViewer.
  const mockRadarPng = createSynthetic512x512Png();
  const samplePalette = 'gradient:#2DBF8C_0_5:#7CD95F_5_15:#FFD800_15_25:#FF0000_25_50';

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

  // --- BENCHMARK 4 : Recoloration PNG Radar Doppler (recolorRadarPng) ---
  suite.measureSync(
    {
      name: 'Recoloration Tuile Radar PNG (512x512)',
      category: 'meteo-radar-recolor',
      iterations,
      regressionThresholdP95Ms: 25.0,
    },
    () => {
      return recolorRadarPng(mockRadarPng, samplePalette);
    },
  );

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
    'Recoloration binaire synchrone sur le thread Node.js : décompression zlib 512x512 saturant sous charge concurrente.',
  );
  suite.addRegressionRisk(
    'Taille mémoire des grilles de vent : fuite potentielle si les textures GPU ne sont pas libérées lors du pan.',
  );
  suite.addRecommendation(
    'Mettre en cache LRU en mémoire les tuiles radar recolorées (clé: tile_z_x_y + hash_palette) pour un coût CPU nul sur requêtes répétées.',
  );
  suite.addRecommendation(
    'Déporter la recoloration RainViewer vers un Web Worker ou shader WebGL côté client pour décharger à 100% le serveur Node.',
  );

  return suite;
}

function createSynthetic512x512Png(): Buffer {
  const width = 512;
  const height = 512;
  // Lignes RGBA : 512 lignes, chacune a 1 octet de filtre + 512 * 4 octets = 2049 octets
  const rawScanlines = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawScanlines[rowOffset] = 0; // Filtre None
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      // Simulation de cellules de pluie
      const dist = Math.hypot(x - 256, y - 256);
      if (dist < 120) {
        rawScanlines[pxOffset] = 220; // R
        rawScanlines[pxOffset + 1] = 80;  // G
        rawScanlines[pxOffset + 2] = 30;  // B
        rawScanlines[pxOffset + 3] = 255; // A
      } else {
        rawScanlines[pxOffset + 3] = 0; // Transparent
      }
    }
  }

  const deflated = deflateSync(rawScanlines, { level: 1 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/meteo.ts')) {
  const quick = process.argv.includes('--quick');
  runMeteoBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
