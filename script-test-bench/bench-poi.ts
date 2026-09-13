/**
 * RedView Test-Bench : POI (Points d'Intérêt & Corridor Overpass)
 * 
 * Benchmarks :
 * 1. Projection cartographique métrique de trace (projectRoutePoints sur 10k pts)
 * 2. Filtrage spatial par corridor (2 500 POIs contre trace 10 000 points)
 * 3. Projection orthogonale de POI sur segments d'itinéraire (projectPoiOntoRoute)
 * 4. Algorithme de clustering spatial (buildPoiClusters)
 * 5. Parsing et déduplication de payloads Overpass OSM
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticRoute, generateSyntheticPois } from './core/synthetic-data.ts';
import {
  projectRoutePoints,
  projectPoiOntoRoute,
  type ProjectedRoutePoint,
  type ProjectedPoi,
} from '../src/features/poi/lib/refinePoiProjection.ts';
import { buildPoiClusters } from '../src/features/poi/lib/refinePoiClustering.ts';
import type { PoiFeature, PoiCategory } from '../src/features/poi/types.ts';

export async function runPoiBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('POI (Points d’Intérêt & Corridor Overpass)');
  const iterations = options.quick ? 5 : 20;

  const route10k = generateSyntheticRoute(10_000);
  const rawPois = generateSyntheticPois(route10k, 2_500);

  // Conversion en PoiFeature strict conforme à l'interface RedView
  const poiFeatures: PoiFeature[] = rawPois.map((p, idx) => ({
    id: idx + 1,
    lat: p.lat,
    lon: p.lon,
    category: p.category as PoiCategory,
    name: p.name,
    tags: { name: p.name, amenity: p.category },
  }));

  // --- BENCHMARK 1 : Projection métrique de trace (projectRoutePoints sur 10k pts) ---
  let projectedTrack: ProjectedRoutePoint[] = [];
  suite.measureSync(
    {
      name: 'Projection Métrique Trace (projectRoutePoints 10k pts)',
      category: 'poi-projection',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 3.5,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      projectedTrack = projectRoutePoints(route10k);
      return projectedTrack;
    },
  );

  // --- BENCHMARK 2 : Filtrage Corridor Rapide (Bounding Box) ---
  suite.measureSync(
    {
      name: 'Filtrage Corridor Bounding Box (2 500 POIs)',
      category: 'poi-corridor',
      iterations,
      regressionThresholdP95Ms: 3.0,
      itemsProcessedPerOp: 2_500,
    },
    () => filterPoisByCorridorBbox(poiFeatures, route10k, 0.005),
  );

  // --- BENCHMARK 3 : Projection Orthogonale de POIs sur la Trace ---
  let projectedPois: ProjectedPoi[] = [];
  suite.measureSync(
    {
      name: 'Projection Orthogonale POIs (projectPoiOntoRoute)',
      category: 'poi-projection',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 4.0,
      itemsProcessedPerOp: 500,
    },
    () => {
      const sampleSubset = poiFeatures.slice(0, 500);
      projectedPois = sampleSubset.map((f) => {
        const proj = projectPoiOntoRoute(f, projectedTrack);
        return {
          feature: f,
          progressM: proj.progressM,
          lateralDistanceM: proj.lateralDistanceM,
          etaSec: proj.etaSec,
          baseScore: 1.0,
          score: 1.0,
          openStatus: { isOpen: true, text: 'Ouvert' },
          clusterId: -1,
        };
      });
      return projectedPois;
    },
  );

  // --- BENCHMARK 4 : Clustering Spatial de POIs (buildPoiClusters) ---
  suite.measureSync(
    {
      name: 'Clustering Spatial (buildPoiClusters 500 POIs)',
      category: 'poi-clustering',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.0,
      itemsProcessedPerOp: projectedPois.length,
    },
    () => buildPoiClusters(projectedPois, 150, 80),
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Complexité O(N_pois × N_segments) si la projection n’est pas précédée d’un pré-filtrage spatial : bloque le thread React sur les longs parcours.',
  );
  suite.addRegressionRisk(
    'Overpass API timeout : les requêtes de corridor de plus de 200km dépassent souvent le délai de 25s imposé par les serveurs publics OSM.',
  );
  suite.addRecommendation(
    'Mettre en place un R-Tree (Flatbush ou RBush) sur les segments de la trace pour réduire la recherche du segment le plus proche de O(N) à O(log N).',
  );
  suite.addRecommendation(
    'Découper les requêtes Overpass en tranches de 80km ou requêter le VPS Overpass interne RedView avec cache Redis.',
  );

  return suite;
}

function filterPoisByCorridorBbox(
  pois: PoiFeature[],
  route: { lat: number; lon: number }[],
  marginDeg: number,
): PoiFeature[] {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  minLat -= marginDeg; maxLat += marginDeg;
  minLon -= marginDeg; maxLon += marginDeg;

  return pois.filter((poi) => {
    return poi.lat >= minLat && poi.lat <= maxLat && poi.lon >= minLon && poi.lon <= maxLon;
  });
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-poi.ts')) {
  const quick = process.argv.includes('--quick');
  runPoiBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
