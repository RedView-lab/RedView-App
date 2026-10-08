/**
 * RedView Test-Bench : Neige — performance du moteur v2
 *
 * Étapes chronométrées sur une scène alpine synthétique 256 × 256 (5 km) :
 * 1. Profil altitudinal AROME (régression locale robuste, 60 × 40 mailles)
 * 2. Indice d'abri Winstral Sx (100 m)
 * 3. Motif de transport éolien (flux de dérive, rose 4 secteurs)
 * 4. Transport gravitaire (SnowSlide + ligne d'énergie)
 * 5. Horizons + rayonnement direct journalier
 * 6. Pipeline complet computeSnowDistribution
 * La qualité (v1 contre v2, vérité synthétique) est dans `npm run bench:snow`.
 */
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { generateSyntheticDemGrid } from '../core/synthetic-data.ts';
import { DEFAULT_SNOW_ENGINE_CONFIG } from '../../src/features/snow/lib/engine/config.ts';
import { fitElevationProfile } from '../../src/features/snow/lib/engine/elevationProfile.ts';
import { snowSlide } from '../../src/features/snow/lib/engine/gravity.ts';
import { buildWorkGrid, SceneFrame } from '../../src/features/snow/lib/engine/grid.ts';
import { computeSnowDistribution } from '../../src/features/snow/lib/engine/pipeline.ts';
import { computeHorizons, dailyRadiationField, daySunPath, surfaceGeometry } from '../../src/features/snow/lib/engine/radiation.ts';
import { AltitudeSampler, shelterIndex, terrainGradients } from '../../src/features/snow/lib/engine/terrain.ts';
import type { CoarseSnowGrid, SnowEngineInput } from '../../src/features/snow/lib/engine/types.ts';
import { defaultWindRose } from '../../src/features/snow/lib/engine/weatherHistory.ts';
import { computeWindPattern } from '../../src/features/snow/lib/engine/wind.ts';

const LON0 = 6.9;
const LAT0 = 45.95;
const M_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const M_LAT = 110_540;

function benchInput(n: number, size: number): SnowEngineInput {
  const dem = generateSyntheticDemGrid(n, n, 1200, 3200);
  const half = size / 2;
  const aw = 60, ah = 40;
  const lonMin = LON0 - 0.3, latMin = LAT0 - 0.2;
  const hs = new Float32Array(aw * ah);
  const oro = new Float32Array(aw * ah);
  for (let j = 0; j < ah; j++) {
    for (let i = 0; i < aw; i++) {
      const z = 1500 + 900 * Math.sin(i / 7) * Math.cos(j / 5);
      oro[j * aw + i] = z;
      hs[j * aw + i] = Math.max(0, 0.12 * (z - 1000));
    }
  }
  const coarse: CoarseSnowGrid = { source: 'arome', width: aw, height: ah, lonMin, latMin, dLon: 0.01, dLat: 0.01, hsCm: hs, orographyM: oro, resolutionM: 1100 };
  return {
    dem: { data: dem, width: n, height: n, sizeX: size, sizeY: size },
    geo: {
      corners: [
        { lon: LON0 - half / M_LON, lat: LAT0 - half / M_LAT },
        { lon: LON0 + half / M_LON, lat: LAT0 - half / M_LAT },
        { lon: LON0 + half / M_LON, lat: LAT0 + half / M_LAT },
        { lon: LON0 - half / M_LON, lat: LAT0 + half / M_LAT },
      ],
      gridNorthBearingDeg: 0,
    },
    coarse,
    farDem: null,
    canopy: null,
    observations: [],
    bra: null,
    weather: null,
    analysisTimeMs: Date.parse('2026-02-15T06:00:00Z'),
    config: { ...DEFAULT_SNOW_ENGINE_CONFIG, maxResolution: n },
  };
}

export async function runSnowBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Neige (moteur v2)');
  const iterations = options.quick ? 3 : 8;
  const input = benchInput(256, 5000);
  const grid = buildWorkGrid(input.dem, 256);
  const frame = new SceneFrame(input.geo);
  const sampler = new AltitudeSampler(grid, null);

  suite.measureSync(
    { name: 'Profil altitudinal AROME (60×40 mailles)', category: 'snow-profile', iterations, regressionThresholdP95Ms: 120, itemsProcessedPerOp: 2400 },
    () => fitElevationProfile(input.coarse, input.coarse.orographyM as Float32Array, 'model', frame, 800, 3600, input.config),
  );
  suite.measureSync(
    { name: 'Indice d’abri Winstral Sx (256×256, 100 m)', category: 'snow-winstral', iterations, regressionThresholdP95Ms: 250, itemsProcessedPerOp: 256 * 256 },
    () => shelterIndex(grid, sampler, 300, grid.ps, 100),
  );
  suite.measureSync(
    { name: 'Motif de transport éolien (256×256, 4 secteurs)', category: 'snow-wind', iterations: Math.max(2, Math.floor(iterations / 2)), regressionThresholdP95Ms: 1500, itemsProcessedPerOp: 256 * 256 },
    () => computeWindPattern(grid, null, frame, defaultWindRose(300), input.config),
  );
  suite.measureSync(
    { name: 'Transport gravitaire SnowSlide + ligne d’énergie (256×256)', category: 'snow-gravity', iterations, regressionThresholdP95Ms: 400, itemsProcessedPerOp: 256 * 256 },
    () => snowSlide(new Float32Array(256 * 256).fill(250), grid, input.config),
  );
  suite.measureSync(
    { name: 'Horizons 24 secteurs + rayonnement journalier (128×128)', category: 'snow-radiation', iterations: Math.max(2, Math.floor(iterations / 2)), regressionThresholdP95Ms: 1500, itemsProcessedPerOp: 128 * 128 * 24 },
    () => {
      const hz = computeHorizons(grid, sampler, 0, Array.from({ length: 24 }, (_, k) => k * 15), 15, 4000, 2);
      const reduced = buildWorkGrid({ data: grid.z, width: grid.width, height: grid.height, sizeX: grid.sizeX, sizeY: grid.sizeY }, hz.width);
      const t = terrainGradients(reduced);
      const geom = surfaceGeometry(t.slopeDeg, t.aspectGridDeg, reduced.z);
      return dailyRadiationField(hz, geom, daySunPath(input.analysisTimeMs, LAT0, LON0, 20), 20, 0.75);
    },
  );
  suite.measureSync(
    { name: 'Pipeline complet v2 (256×256, sans historique météo)', category: 'snow-full-pipeline', iterations: Math.max(2, Math.floor(iterations / 2)), regressionThresholdP95Ms: 4000 },
    () => computeSnowDistribution(input),
  );

  suite.addRegressionRisk(
    'Indice Sx et horizons : O(N × distances × secteurs). La grille de travail est plafonnée (maxResolution 640) et les horizons sont calculés à demi-résolution au-delà de 400 nœuds.',
  );
  suite.addRegressionRisk(
    'SnowSlide trie tous les nœuds par surface de neige à chaque passe (2 passes) : O(N log N).',
  );
  suite.addRecommendation(
    'Le moteur tourne dans un Web Worker (lib/engineWorker.ts) ; les données (AROME, stations, BRA, météo, MNT lointain) sont chargées en parallèle avant.',
  );
  return suite;
}

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/neige.ts')) {
  const quick = process.argv.includes('--quick');
  runSnowBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
