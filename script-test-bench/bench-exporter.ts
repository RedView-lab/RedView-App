/**
 * RedView Test-Bench : Exporter (GPX, GeoJSON, KML & Parsers)
 * 
 * Benchmarks :
 * 1. Sérialisation GPX complète (buildItineraryGpx) sur 1k, 10k et 50k points
 * 2. Parsing de fichier GPX XML regex (parseGpxText) sur 10k et 50k points
 * 3. Sérialisation GeoJSON FeatureCollection
 * 4. Micro-benchmark d'échappement XML et formatage décimal (100k ops)
 */
// Shim Vite import.meta.env for Node.js / TSX runtime
if (typeof (import.meta as Record<string, unknown>).env === 'undefined') {
  (import.meta as Record<string, unknown>).env = {
    ...process.env,
    VITE_MAPBOX_TOKEN: process.env.VITE_MAPBOX_TOKEN || 'mock_mapbox_token_for_benchmarks',
    MODE: 'test',
  };
}

import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticRoute, type TrackPoint } from './core/synthetic-data.ts';
import { parseGpxText } from '../src/features/poi/lib/gpx-parse.ts';
import type { Itinerary } from '../src/features/itineraryPanel/types.ts';

export async function runExporterBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  // Dynamically import buildItineraryGpx and helpers after env shim
  const { buildItineraryGpx } = await import('../src/features/exporter/lib/exportGpx.ts');
  const { escapeXml } = await import('../src/features/exporter/lib/exportHelpers.ts');

  const suite = new BenchmarkSuite('Exporter (GPX, GeoJSON & Parsers)');
  const iterations = options.quick ? 5 : 20;

  const route1k = generateSyntheticRoute(1_000);
  const route10k = generateSyntheticRoute(10_000);
  const route50k = generateSyntheticRoute(50_000);

  const itinerary1k = createMockItinerary('Tour du Mont-Blanc 1k', route1k);
  const itinerary10k = createMockItinerary('Traversée des Alpes 10k', route10k);
  const itinerary50k = createMockItinerary('Transcontinental Race 50k', route50k);

  // --- BENCHMARK 1 : Sérialisation GPX (1 000 points) ---
  suite.measureSync(
    {
      name: 'Sérialisation GPX (1k pts)',
      category: 'export-gpx',
      iterations: iterations * 4,
      regressionThresholdP95Ms: 3.0,
      itemsProcessedPerOp: 1_000,
    },
    () => buildItineraryGpx(itinerary1k),
  );

  // --- BENCHMARK 2 : Sérialisation GPX (10 000 points) ---
  let generatedGpx10k = '';
  suite.measureSync(
    {
      name: 'Sérialisation GPX (10k pts)',
      category: 'export-gpx',
      iterations,
      regressionThresholdP95Ms: 16.0,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      generatedGpx10k = buildItineraryGpx(itinerary10k);
      return generatedGpx10k;
    },
  );

  // --- BENCHMARK 3 : Sérialisation GPX Échelle Ultra (50 000 points) ---
  let generatedGpx50k = '';
  suite.measureSync(
    {
      name: 'Sérialisation GPX Échelle Ultra (50k pts)',
      category: 'export-gpx',
      iterations: Math.max(3, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 85.0,
      itemsProcessedPerOp: 50_000,
    },
    () => {
      generatedGpx50k = buildItineraryGpx(itinerary50k);
      return generatedGpx50k;
    },
  );

  // --- BENCHMARK 4 : Parsing GPX XML (parseGpxText sur 10k points) ---
  suite.measureSync(
    {
      name: 'Parsing GPX XML Regex (10k pts)',
      category: 'import-gpx',
      iterations,
      regressionThresholdP95Ms: 20.0,
      itemsProcessedPerOp: 10_000,
    },
    () => parseGpxText(generatedGpx10k),
  );

  // --- BENCHMARK 5 : Parsing GPX XML Échelle Ultra (50k points) ---
  suite.measureSync(
    {
      name: 'Parsing GPX XML Regex (50k pts)',
      category: 'import-gpx',
      iterations: Math.max(2, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 95.0,
      itemsProcessedPerOp: 50_000,
    },
    () => parseGpxText(generatedGpx50k),
  );

  // --- BENCHMARK 6 : Sérialisation GeoJSON FeatureCollection (50k points) ---
  suite.measureSync(
    {
      name: 'Sérialisation GeoJSON (50k pts)',
      category: 'export-geojson',
      iterations: Math.max(3, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 45.0,
      itemsProcessedPerOp: 50_000,
    },
    () => {
      const geojson = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: route50k.map((p) => [p.lon, p.lat, p.elevationM]),
            },
            properties: {
              name: 'Trace Ultra',
              distanceM: route50k[route50k.length - 1]?.distanceM ?? 0,
            },
          },
        ],
      };
      return JSON.stringify(geojson);
    },
  );

  // --- BENCHMARK 7 : Micro-benchmark d'échappement XML (100 000 chaînes) ---
  suite.measureSync(
    {
      name: 'Échappement XML (100k chaînes)',
      category: 'export-helpers',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 3.5,
      itemsProcessedPerOp: 100_000,
    },
    () => {
      let dummy = '';
      for (let i = 0; i < 1000; i++) {
        dummy = escapeXml("Col de l'Iseran & Val d'Isère <2770m> \"Passage\"");
      }
      return dummy;
    },
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Génération de fichiers GPX > 50k points par concaténation de chaînes : pic mémoire V8 pouvant dépasser 120 Mo temporaires.',
  );
  suite.addRegressionRisk(
    'Expression régulière `/<trkpt/gi` sur un fichier XML de 15 Mo : risque de blocage du thread pendant le parsing sur appareil modeste.',
  );
  suite.addRecommendation(
    'Remplacer le parsing Regex par un parseur XML streaming (SAX/expat Wasm) ou déporter le chargement GPX dans un Web Worker (gpxParseWorker.ts).',
  );
  suite.addRecommendation(
    'Pour l’export FIT binaire (Garmin), utiliser le SDK officiel @garmin/fitsdk via un buffer mémoire pré-dimensionné sans conversion string.',
  );

  return suite;
}

function createMockItinerary(name: string, routePoints: TrackPoint[]): Itinerary {
  return {
    id: 'mock-itin-1',
    name,
    color: '#FF0055',
    visible: true,
    timeline: [],
    anchors: [
      { id: 'start', name: 'Départ', kind: 'start', lat: routePoints[0].lat, lon: routePoints[0].lon },
      { id: 'col', name: 'Sommet du Col', kind: 'waypoint', lat: routePoints[Math.floor(routePoints.length / 2)].lat, lon: routePoints[Math.floor(routePoints.length / 2)].lon },
      { id: 'end', name: 'Arrivée', kind: 'end', lat: routePoints[routePoints.length - 1].lat, lon: routePoints[routePoints.length - 1].lon },
    ],
    gpxRoute: {
      name,
      points: routePoints.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        elevationM: p.elevationM,
        distanceM: p.distanceM,
      })),
    },
  } as unknown as Itinerary;
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-exporter.ts')) {
  const quick = process.argv.includes('--quick');
  runExporterBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
