/**
 * RedView Test-Bench : Altitude (Elevation, MNT, D+/D- & Profils)
 *
 * Mesure le VRAI code :
 * 1. Overlay altitude hors zone (src/features/altitude/lib/altitude-dem-source.ts) :
 *    réencodage Terrain-RGB de la tuile DEM déjà décodée par le terrain
 *    (tuile 512 exacte et ancêtre recadré).
 * 2. Overlay altitude en zone d'analyse (public/sw-dem/processing/altitude.js) :
 *    RGBA Terrain-RGB + masque de zone + PNG.
 * 3. D+/D- et profil de pente d'une trace de 50 000 points
 *    (src/features/itineraryPanel/lib/route-metrics), calculés à chaque
 *    routage / import GPX.
 * 4. Route de secours serveur /altitude-tiles (server/terrain-tiles.mjs) À FROID,
 *    une tuile différente par itération, Terrarium simulé (sans réseau) — la
 *    même tuile ne mesurait que le cache LRU (0,002 ms jusqu'au 2026-10-01).
 * 5. Construction des palettes d'altitude (buildAltitudeCategories).
 */
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { generateSyntheticDemGrid, generateSyntheticRoute } from '../core/synthetic-data.ts';
import { loadSwModules } from '../core/sw-context.ts';
import { encodeTerrariumPng, withTerrariumFetch } from '../core/terrarium-mock.ts';
import { buildAltitudeCategories } from '../../src/features/altitude/lib/altitude-config.ts';
import { computeRouteElevationMetrics } from '../../src/features/itineraryPanel/lib/route-metrics/metrics.ts';
import { extractRouteProfileFromPoints } from '../../src/features/itineraryPanel/lib/route-metrics/profile.ts';
import { generateAltitudeTile } from '../../server/terrain-tiles.mjs';

type AltitudeSw = {
  encodeAltitudePng: (elevations: Float32Array, zoneMask: Uint8Array | null) => Promise<Blob>;
  rasterizeRingMask: (ring: number[][], z: number, x: number, y: number, size: number) => Uint8Array | null;
};

// Node n'a pas d'ImageData : encodeDem n'en lit que width/height/data.
class NodeImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

export async function runAltiBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('Altitude (Elevation & D+/D-)');
  const iterations = options.quick ? 5 : 20;

  const g = globalThis as unknown as { ImageData?: unknown };
  g.ImageData ??= NodeImageData;
  const { encodeDem } = await import('../../src/features/altitude/lib/altitude-dem-source.ts');
  const sw = loadSwModules([
    'core/config.js',
    'core/geo.js',
    'core/interpolation.js',
    'core/terrain-rgb.js',
    'workers/slope-math.js',
    'processing/altitude.js',
  ]) as unknown as AltitudeSw;

  // DEMData de Mapbox : grille dim² + bordure de 1 px.
  const dim = 512;
  const grid = generateSyntheticDemGrid(dim + 2, dim + 2);
  const dem = { dim, stride: dim + 2, floatView: grid };
  const tile256 = generateSyntheticDemGrid(256, 256);

  const route50k = generateSyntheticRoute(50_000).map((p) => ({
    lat: p.lat,
    lon: p.lon,
    elevationM: p.elevationM,
  }));

  // ── Overlay altitude ────────────────────────────────────────────────
  suite.measureSync(
    {
      name: 'Overlay altitude : encodeDem tuile 512',
      category: 'alti-overlay-encode',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 6.0,
      itemsProcessedPerOp: dim * dim,
    },
    () => encodeDem(dem),
  );
  suite.measureSync(
    {
      name: 'Overlay altitude : encodeDem ancêtre recadré (dz=2)',
      category: 'alti-overlay-encode-crop',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 10.0,
      itemsProcessedPerOp: dim * dim,
    },
    () => encodeDem(dem, 2, 1, 3),
  );
  const zoneMask = sw.rasterizeRingMask([[6.86, 45.88], [6.9, 45.88], [6.9, 45.91], [6.86, 45.91]], 13, 4252, 2917, 256);
  await suite.measureAsync(
    {
      name: 'SW altitude zone 256 (RGBA + masque + PNG)',
      category: 'alti-zone-sw',
      iterations,
      regressionThresholdP95Ms: 20.0,
    },
    () => sw.encodeAltitudePng(tile256, zoneMask),
  );

  // ── Métriques de la trace (code app) ───────────────────────────────
  suite.measureSync(
    {
      name: 'D+/D- trace 50k pts (computeRouteElevationMetrics)',
      category: 'alti-elevation-gain',
      iterations,
      regressionThresholdP95Ms: 60.0,
      itemsProcessedPerOp: 50_000,
    },
    () => computeRouteElevationMetrics(route50k),
  );
  suite.measureSync(
    {
      name: 'Profil de pente trace 50k pts (extractRouteProfileFromPoints)',
      category: 'alti-profile',
      iterations,
      regressionThresholdP95Ms: 60.0,
      itemsProcessedPerOp: 50_000,
    },
    () => extractRouteProfileFromPoints(route50k),
  );

  suite.measureSync(
    {
      name: 'Génération Échelle Altitudes (6 couleurs)',
      category: 'alti-config',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 0.2,
    },
    () => buildAltitudeCategories('6 couleurs'),
  );

  // ── Route de secours serveur, à froid ──────────────────────────────
  let column = 0;
  await withTerrariumFetch(encodeTerrariumPng(tile256), async () => {
    await suite.measureAsync(
      {
        name: 'Serveur /altitude-tiles à froid (z12)',
        category: 'alti-tile-server',
        iterations: options.quick ? 4 : 12,
        regressionThresholdP95Ms: 40.0,
      },
      async () => {
        const png = await generateAltitudeTile(12, 1000 + column++, 1446);
        if (!png) throw new Error('[bench-alti] /altitude-tiles a rendu null');
        return png;
      },
    );
  });

  suite.addRegressionRisk(
    'Overlay altitude hors zone : il ne doit jamais retélécharger la tuile DEM (réencodage en mémoire de tile.dem).',
  );
  suite.addRegressionRisk(
    'D+ : le seuil (2 m) et le lissage (5 points) de computeRouteElevationMetrics changent le dénivelé affiché de toutes les traces.',
  );
  suite.addRecommendation(
    'Le D+ d\'une trace de 50 000 points coûte ~15-30 ms (haversine) une fois par routage ou import : pas un chemin chaud.',
  );

  return suite;
}

// Standalone execution
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/alti.ts')) {
  const quick = process.argv.includes('--quick');
  runAltiBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
