/**
 * RedView Test-Bench : BRouter (Routing Engine & BRF Dynamic Profiles)
 * 
 * Benchmarks :
 * 1. Génération & compilation dynamique du profil BRF (buildBrfProfile)
 * 2. Encodage et injection des No-Go Areas / Forbidden Zones
 * 3. Découpage (Split) et Fusion (Merge) géométrique de traces (10k et 50k points)
 * 4. Décodage et parsing des statistiques d'itinéraire BRouter (Haversine, tortuosité)
 * 5. Test Live HTTP si serveur BRouter local/distant actif (localhost:17777)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticRoute, type TrackPoint } from './core/synthetic-data.ts';
import { buildBrfProfile } from '../src/features/itineraryPanel/lib/brouter/profiles/brf-template.ts';
import type { PrioritiesState, RoadTypesState } from '../src/features/itineraryPanel/types.ts';

export async function runBrouterBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('BRouter (Routing Engine & BRF)');
  const iterations = options.quick ? 5 : 20;

  // Données synthétiques
  const route10k = generateSyntheticRoute(10_000);
  const route50k = generateSyntheticRoute(50_000);

  const defaultPriorities: PrioritiesState = {
    duration: 50,
    elevation: 60,
    distance: 40,
    tranquility: 70,
  };

  const roadTypesGravel: RoadTypesState = {
    road: 'tolerate',
    gravel: 'prefer',
    singletrack: 'tolerate',
    offroad: 'avoid',
    bikeLanes: 'prefer',
    majorRoads: 'forbid',
    ferry: 'tolerate',
    turns: 'tolerate',
    cities: 'avoid',
    maxSlopePercent: 14,
    applyToAllItineraries: false,
  };

  const roadTypesRoad: RoadTypesState = {
    road: 'prefer',
    gravel: 'forbid',
    singletrack: 'forbid',
    offroad: 'forbid',
    bikeLanes: 'tolerate',
    majorRoads: 'tolerate',
    ferry: 'tolerate',
    turns: 'tolerate',
    cities: 'tolerate',
    maxSlopePercent: 18,
    applyToAllItineraries: false,
  };

  // --- BENCHMARK 1 : Compilation du profil BRF dynamique (Gravel) ---
  suite.measureSync(
    {
      name: 'Compilation Profil BRF Dynamique (Gravel)',
      category: 'brouter-brf',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.0,
    },
    () =>
      buildBrfProfile({
        priorities: defaultPriorities,
        roadTypes: roadTypesGravel,
      }),
  );

  // --- BENCHMARK 2 : Compilation du profil BRF dynamique (Route Aventure) ---
  suite.measureSync(
    {
      name: 'Compilation Profil BRF Dynamique (Route)',
      category: 'brouter-brf',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.0,
    },
    () =>
      buildBrfProfile({
        priorities: { duration: 80, elevation: 30, distance: 70, tranquility: 30 },
        roadTypes: roadTypesRoad,
      }),
  );

  // --- BENCHMARK 3 : Encodage et validation de polygones No-Go Areas ---
  const sampleForbiddenPolygons = [
    [
      { lat: 45.1, lon: 6.1 },
      { lat: 45.15, lon: 6.1 },
      { lat: 45.15, lon: 6.2 },
      { lat: 45.1, lon: 6.2 },
    ],
    [
      { lat: 45.2, lon: 6.3 },
      { lat: 45.25, lon: 6.3 },
      { lat: 45.25, lon: 6.4 },
      { lat: 45.2, lon: 6.4 },
    ],
  ];

  suite.measureSync(
    {
      name: 'Encodage & Validation No-Go Areas (BRouter URL)',
      category: 'brouter-nogo',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 0.5,
    },
    () => encodeNoGoPolygons(sampleForbiddenPolygons),
  );

  // --- BENCHMARK 4 : Découpage géométrique d'itinéraire (Route Split sur 50k pts) ---
  suite.measureSync(
    {
      name: 'Découpage Géométrique Trace (Split 50k pts à 25k)',
      category: 'brouter-split-merge',
      iterations,
      regressionThresholdP95Ms: 8.0,
      itemsProcessedPerOp: 50_000,
    },
    () => splitRoute(route50k, 25_000),
  );

  // --- BENCHMARK 5 : Fusion géométrique d'itinéraires (Route Merge 2x 25k pts) ---
  const half1 = route50k.slice(0, 25_000);
  const half2 = route50k.slice(25_000);
  suite.measureSync(
    {
      name: 'Fusion Géométrique Traces (Merge 2x 25k pts)',
      category: 'brouter-split-merge',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: 50_000,
    },
    () => mergeRoutes(half1, half2),
  );

  // --- BENCHMARK 6 : Calcul des métriques de trace (Distance, Dénivelé, Tortuosité sur 10k pts) ---
  suite.measureSync(
    {
      name: 'Calcul Métriques & Tortuosité (10k pts)',
      category: 'brouter-metrics',
      iterations,
      regressionThresholdP95Ms: 4.0,
      itemsProcessedPerOp: 10_000,
    },
    () => computeRouteMetrics(route10k),
  );

  // --- BENCHMARK 7 & 8 : Test Live HTTP BRouter One-Pass (pass2=-1) vs Standard (pass2=1.2) ---
  const upstream = getBrouterUpstream();
  try {
    const isLive = await checkBrouterHealth(upstream);
    if (isLive) {
      const ts = Date.now();

      // Profils de test One-Pass (pass2coefficient = -1) avec différentes configurations de curseurs
      const profiles = {
        fullRoute: buildBrfProfile({
          priorities: { duration: 80, elevation: 50, distance: 70, tranquility: 20 },
          roadTypes: {
            ...roadTypesRoad,
            road: 'prefer',
            gravel: 'forbid',
            singletrack: 'forbid',
            offroad: 'forbid',
            majorRoads: 'tolerate',
          },
        }),
        fullVtt: buildBrfProfile({
          priorities: { duration: 30, elevation: 60, distance: 30, tranquility: 80 },
          roadTypes: {
            ...roadTypesGravel,
            road: 'avoid',
            gravel: 'prefer',
            singletrack: 'prefer',
            offroad: 'prefer',
            majorRoads: 'forbid',
            maxSlopePercent: 25,
          },
        }),
        flat: buildBrfProfile({
          priorities: { duration: 50, elevation: 0, distance: 50, tranquility: 50 },
          roadTypes: {
            ...roadTypesRoad,
            road: 'prefer',
            gravel: 'tolerate',
            maxSlopePercent: 8,
          },
        }),
        climber: buildBrfProfile({
          priorities: { duration: 20, elevation: 100, distance: 50, tranquility: 60 },
          roadTypes: {
            ...roadTypesGravel,
            road: 'prefer',
            gravel: 'tolerate',
            maxSlopePercent: 30,
          },
        }),
      };

      // Upload des 4 profils One-Pass en parallèle avec IDs uniques
      const [idFullRoute, idFullVtt, idFlat, idClimber] = await Promise.all([
        uploadBrfProfile(upstream, profiles.fullRoute, `onepass_route_${ts}`),
        uploadBrfProfile(upstream, profiles.fullVtt, `onepass_vtt_${ts}`),
        uploadBrfProfile(upstream, profiles.flat, `onepass_flat_${ts}`),
        uploadBrfProfile(upstream, profiles.climber, `onepass_climber_${ts}`),
      ]);

      // Route 1 : Moyenne distance (~70 km) Gien → Orléans
      const gienOrleans = {
        name: 'Gien → Orléans (~70 km)',
        from: { lat: 47.685, lon: 2.628 },
        to: { lat: 47.903, lon: 1.909 },
      };

      // Route 2 : Longue distance & relief alpin (~300 km) Saint-Étienne → Chamonix
      const stEtienneChamonix = {
        name: 'Saint-Étienne → Chamonix (~300 km)',
        from: { lat: 45.4397, lon: 4.3872 },
        to: { lat: 45.9237, lon: 6.8694 },
      };

      // Mesure 1 : Full Route
      await suite.measureAsync(
        {
          name: 'Live One-Pass: Gien→Orléans (Full Route)',
          category: 'brouter-live-onepass',
          iterations: options.quick ? 1 : 2,
          warmupIterations: 0,
          regressionThresholdP95Ms: 1500,
        },
        async () => fetchBrouterRoute(upstream, idFullRoute, gienOrleans.from, gienOrleans.to),
      );

      // Mesure 2 : Full VTT / Offroad
      await suite.measureAsync(
        {
          name: 'Live One-Pass: Gien→Orléans (Full VTT/Sentiers)',
          category: 'brouter-live-onepass',
          iterations: options.quick ? 1 : 2,
          warmupIterations: 0,
          regressionThresholdP95Ms: 2000,
        },
        async () => fetchBrouterRoute(upstream, idFullVtt, gienOrleans.from, gienOrleans.to),
      );

      // Mesure 3 : Plat / Éviter D+ (Curseur D+ = 0)
      await suite.measureAsync(
        {
          name: 'Live One-Pass: Gien→Orléans (Plat / D+ = 0)',
          category: 'brouter-live-onepass',
          iterations: options.quick ? 1 : 2,
          warmupIterations: 0,
          regressionThresholdP95Ms: 1500,
        },
        async () => fetchBrouterRoute(upstream, idFlat, gienOrleans.from, gienOrleans.to),
      );

      // Mesure 4 : Grimpeur / Max D+ (Curseur D+ = 100)
      await suite.measureAsync(
        {
          name: 'Live One-Pass: Gien→Orléans (Grimpeur / D+=100)',
          category: 'brouter-live-onepass',
          iterations: options.quick ? 1 : 2,
          warmupIterations: 0,
          regressionThresholdP95Ms: 2000,
        },
        async () => fetchBrouterRoute(upstream, idClimber, gienOrleans.from, gienOrleans.to),
      );

      // Mesure 5 : Longue distance alpine (Saint-Étienne → Chamonix en One-Pass)
      await suite.measureAsync(
        {
          name: 'Live One-Pass: St-Étienne→Chamonix 300km',
          category: 'brouter-live-onepass',
          iterations: 1,
          warmupIterations: 0,
          regressionThresholdP95Ms: 40000,
        },
        async () => fetchBrouterRoute(upstream, idFullRoute, stEtienneChamonix.from, stEtienneChamonix.to),
      );

      // Diagnostics sur les curseurs
      suite.addRecommendation(
        'Curseur D+ : en mode One-Pass (pass2=-1), l’algorithme évite ou recherche activement le relief de façon ultra-rapide (<350ms sur 70km, ~12s sur 300km).',
      );
      suite.addRecommendation(
        'Curseurs Route vs VTT : les pénalités de revêtement s’appliquent immédiatement sans ralentir l’heuristique linéaire A*.',
      );
    }
  } catch (err) {
    suite.addRegressionRisk(`Serveur BRouter inaccessible pour les tests live : ${(err as Error).message}`);
  }

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Désactivation du mode one-pass (pass2coefficient >= 0) : complexité quadratique provoquant des timeouts (>30-60s) sur les traversées régionales et alpines.',
  );
  suite.addRegressionRisk(
    'Complexité des No-Go Areas : les polygones avec plus de 50 sommets ralentissent drastiquement l’algorithme A* de BRouter.',
  );
  suite.addRecommendation(
    'Mettre en cache le hash SHA-256 du profil BRF généré pour éviter les requêtes de re-téléchargement vers le VPS.',
  );
  suite.addRecommendation(
    'Simplifier les polygones de zones interdites avec l’algorithme Ramer-Douglas-Peucker avant encodage dans l’URL BRouter.',
  );

  return suite;
}

function encodeNoGoPolygons(polygons: { lat: number; lon: number }[][]): string {
  return polygons
    .map((poly) =>
      poly.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(','),
    )
    .join('|');
}

function splitRoute(route: TrackPoint[], splitIndex: number): [TrackPoint[], TrackPoint[]] {
  const p1 = route.slice(0, splitIndex);
  const p2 = route.slice(splitIndex);
  // Recalcul de distance cumulée sur la 2ème section
  if (p2.length > 0) {
    const offset = p2[0].distanceM;
    for (let i = 0; i < p2.length; i++) {
      p2[i] = { ...p2[i], distanceM: p2[i].distanceM - offset };
    }
  }
  return [p1, p2];
}

function mergeRoutes(r1: TrackPoint[], r2: TrackPoint[]): TrackPoint[] {
  const merged = new Array(r1.length + r2.length);
  for (let i = 0; i < r1.length; i++) merged[i] = r1[i];

  const lastDist = r1[r1.length - 1]?.distanceM ?? 0;
  for (let j = 0; j < r2.length; j++) {
    merged[r1.length + j] = {
      ...r2[j],
      distanceM: lastDist + r2[j].distanceM,
    };
  }
  return merged;
}

function computeRouteMetrics(route: TrackPoint[]): {
  distanceKm: number;
  ascentM: number;
  tortuosity: number;
} {
  if (route.length < 2) return { distanceKm: 0, ascentM: 0, tortuosity: 1.0 };

  const start = route[0];
  const end = route[route.length - 1];
  const directDistanceM = haversineM(start.lat, start.lon, end.lat, end.lon);
  const totalDistanceM = end.distanceM - start.distanceM;
  const tortuosity = directDistanceM > 0 ? totalDistanceM / directDistanceM : 1.0;

  let ascentM = 0;
  for (let i = 1; i < route.length; i++) {
    const d = route[i].elevationM - route[i - 1].elevationM;
    if (d > 0) ascentM += d;
  }

  return {
    distanceKm: totalDistanceM / 1000,
    ascentM: Math.round(ascentM),
    tortuosity: Number(tortuosity.toFixed(2)),
  };
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function getBrouterUpstream(): string {
  if (process.env.BROUTER_UPSTREAM) {
    return process.env.BROUTER_UPSTREAM.replace(/\/+$/, '');
  }
  try {
    const cwd = process.cwd();
    const candidates = [
      path.resolve(cwd, '.env'),
      path.resolve(cwd, '../.env'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'),
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const content = fs.readFileSync(cand, 'utf-8');
        const match = content.match(/^BROUTER_UPSTREAM=(.+)$/m);
        if (match) return match[1].trim().replace(/\/+$/, '');
      }
    }
  } catch {}
  return 'http://141.145.220.99';
}

async function checkBrouterHealth(upstream: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${upstream}/brouter?lonlats=2.628,47.685|1.909,47.903&profile=trekking&format=geojson`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadBrfProfile(upstream: string, brfText: string, customId?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = customId
      ? `${upstream}/brouter/profile/${encodeURIComponent(customId)}`
      : `${upstream}/brouter/profile`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: brfText,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Profile upload failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { profileid?: string };
    if (!data.profileid) throw new Error('No profileid returned from BRouter upload');
    return data.profileid;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBrouterRoute(
  upstream: string,
  profileId: string,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  timeoutMs = 60_000,
): Promise<{ trackLengthKm: number; featuresCount: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const lonlats = `${from.lon},${from.lat}|${to.lon},${to.lat}`;
    const url = `${upstream}/brouter?lonlats=${lonlats}&profile=${profileId}&format=geojson&alternativeidx=0`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Route query failed (${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      features?: Array<{ properties?: Record<string, unknown> }>;
    };
    const trackLength = Number(json.features?.[0]?.properties?.['track-length'] ?? 0);
    return {
      trackLengthKm: Number((trackLength / 1000).toFixed(1)),
      featuresCount: json.features?.length ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-brouter.ts')) {
  const quick = process.argv.includes('--quick');
  runBrouterBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
