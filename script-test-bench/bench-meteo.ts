/**
 * RedView Test-Bench : Météorologie (Weather)
 * 
 * Benchmarks :
 * 1. Décodage et parsing JSON du payload Open-Meteo (168h x 14 variables)
 * 2. Interpolation spatio-temporelle de météo le long d'un parcours (10 000 points)
 * 3. Calcul de grille de vent régulière vectorielle (computeWindGrid) pour GPU
 * 4. Pipeline de recoloration binaire de tuiles radar RainViewer (recolorRadarPng)
 * 5. Test de latence Live HTTP (si VPS ou serveur actif)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import {
  generateSyntheticWeather,
  generateSyntheticRoute,
  type SyntheticWeatherPayload,
} from './core/synthetic-data.ts';
import { computeWindGrid } from '../src/features/weather/lib/wind-grid.ts';
import { recolorRadarPng } from '../server/radar-recolor.mjs';
import { deflateSync, crc32 } from 'node:zlib';

export async function runMeteoBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Météo (Weather & Radar)');
  const iterations = options.quick ? 5 : 20;

  // 1. Préparation des données synthétiques
  const rawWeather = generateSyntheticWeather(45.9237, 6.8694);
  const rawWeatherJson = JSON.stringify(rawWeather);
  const route10k = generateSyntheticRoute(10_000);

  // 2. Création d'un buffer PNG 512x512 valide pour le test RainViewer radar
  const mockRadarPng = createSynthetic512x512Png();
  const samplePalette = 'gradient:#2DBF8C_0_5:#7CD95F_5_15:#FFD800_15_25:#FF0000_25_50';

  // --- BENCHMARK 1 : Parsing & Normalisation du JSON Open-Meteo ---
  suite.measureSync(
    {
      name: 'Parsing JSON Open-Meteo (168h x 11 vars)',
      category: 'meteo-parsing',
      iterations,
      regressionThresholdP95Ms: 5.0,
      itemsProcessedPerOp: 168 * 11,
    },
    () => {
      const parsed: SyntheticWeatherPayload = JSON.parse(rawWeatherJson);
      // Extraction et vérification des séries temporelles
      let sumTemp = 0;
      const count = parsed.hourly.temperature_2m.length;
      for (let i = 0; i < count; i++) {
        sumTemp += parsed.hourly.temperature_2m[i];
      }
      return sumTemp;
    },
  );

  // --- BENCHMARK 2 : Interpolation météo le long d'une trace de 10 000 points ---
  suite.measureSync(
    {
      name: 'Interpolation Trace (10k pts)',
      category: 'meteo-interpolation',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      const weather = rawWeather.hourly;
      const hoursCount = weather.time.length;
      const interpolated = new Float32Array(route10k.length);

      for (let i = 0; i < route10k.length; i++) {
        const pt = route10k[i];
        // Projection temporelle sur la semaine (168h)
        const hourIndex = Math.min(hoursCount - 1, Math.floor((pt.timeSec ?? 0) / 3600) % hoursCount);
        const nextHourIndex = Math.min(hoursCount - 1, hourIndex + 1);
        const frac = ((pt.timeSec ?? 0) % 3600) / 3600;

        // Gradient adiabatique selon altitude (-6.5°C / 1000m)
        const baseTemp = weather.temperature_2m[hourIndex];
        const nextTemp = weather.temperature_2m[nextHourIndex];
        const tempAtSea = baseTemp * (1 - frac) + nextTemp * frac;
        const altitudeCorrection = ((pt.elevationM - rawWeather.elevation) / 1000) * -6.5;

        interpolated[i] = tempAtSea + altitudeCorrection;
      }
      return interpolated;
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
  // Scanlines RGBA: 512 rows, each has 1 filter byte + 512 * 4 bytes = 2049 bytes
  const rawScanlines = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    rawScanlines[rowOffset] = 0; // Filter None
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      // Rain cell simulation
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

// Standalone execution
if (process.argv[1]?.endsWith('bench-meteo.ts')) {
  const quick = process.argv.includes('--quick');
  runMeteoBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
