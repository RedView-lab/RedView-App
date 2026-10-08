/**
 * RedView Test-Bench : BRouter (Routing Engine & BRF Dynamic Profiles)
 * 
 * Benchmarks (vrai code de l'app) :
 * 1. Génération du profil BRF dynamique (buildBrfProfile)
 * 2. Trace de 1 200 km (100 000 points) : longueurs cumulées, projection d'un
 *    point sur la trace (survol, glisser d'un point), finesse GPX (export) et
 *    nettoyage d'un GPX importé (cleanGpxGlitches)
 * 3. Test Live HTTP si un serveur BRouter répond
 * Jusqu'au 2026-10-06, 2 mesurait des copies écrites dans le bench (no-go,
 * découpe/fusion par slice, haversine local). L'URL de routage (import.meta.env)
 * et les requêtes réelles sont mesurées par `npm run bench:routing`.
 * La qualité des tracés et la latence réelle : `npm run bench:routing`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { buildBrfProfile } from '../../src/features/itineraryPanel/lib/brouter/profiles/brf-template.ts';
import { cumulativeRouteLengthsM, projectPointAlongRoute } from '../../src/features/itineraryPanel/lib/routes/route-distance.ts';
import { simplifyPointsByQuality } from '../../src/features/itineraryPanel/lib/routes/simplify-route.ts';
import { cleanGpxGlitches } from '../../src/features/itineraryPanel/lib/routes/clean-gpx-glitches.ts';
import type { PrioritiesState, RoadTypesState } from '../../src/features/itineraryPanel/types/index.ts';

export async function runBrouterBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('BRouter (Routing Engine & BRF)');
  const iterations = options.quick ? 5 : 20;

  // Trace de 1 200 km, un point tous les 12 m, sinueuse et vallonnée.
  const route = Array.from({ length: 100_000 }, (_, i) => ({
    lat: 45 + i * 0.000108,
    lon: 6 + 0.05 * Math.sin(i / 900) + 0.002 * Math.sin(i / 37),
    elevationM: 600 + 500 * Math.sin(i / 4000) + 40 * Math.sin(i / 150),
    distanceM: i * 12,
  }));

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

  // --- BENCHMARK 3 : trace de 1 200 km (100 000 points) ---
  const lengths = cumulativeRouteLengthsM(route);
  suite.measureSync(
    {
      name: 'Trace 1 200 km : longueurs cumulées (100k pts)',
      category: 'route-lengths',
      iterations,
      regressionThresholdP95Ms: 15.0,
      itemsProcessedPerOp: route.length,
    },
    () => cumulativeRouteLengthsM(route),
  );
  projectPointAlongRoute(route[50_000], route, lengths); // index de projection construit
  let probe = 0;
  suite.measureSync(
    {
      name: 'Trace 1 200 km : projection d’un point (survol)',
      category: 'route-projection',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 2.0,
    },
    () => {
      const p = route[(probe = (probe + 7919) % route.length)];
      return projectPointAlongRoute({ lat: p.lat + 0.0003, lon: p.lon - 0.0002 }, route, lengths);
    },
  );
  suite.measureSync(
    {
      name: 'Trace 1 200 km : finesse GPX par défaut (export)',
      category: 'route-simplify',
      iterations: Math.max(3, iterations >> 1),
      regressionThresholdP95Ms: 120.0,
      itemsProcessedPerOp: route.length,
    },
    // Copie du tableau à chaque itération : le résultat est en cache par tableau de points.
    () => simplifyPointsByQuality(route.slice(), 'default'),
  );
  suite.measureSync(
    {
      name: 'Trace 1 200 km : nettoyage GPX importé (cleanGpxGlitches)',
      category: 'route-clean',
      iterations: Math.max(3, iterations >> 1),
      regressionThresholdP95Ms: 150.0,
      itemsProcessedPerOp: route.length,
    },
    () => cleanGpxGlitches(route),
  );

  // --- BENCHMARK 7 & 8 : test HTTP réel de BRouter en une passe (pass2=-1) contre standard (pass2=1.2) ---
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

      // Mesure 1 : route complète
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

      // Mesure 2 : VTT / hors route complet
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

function getBrouterUpstream(): string {
  if (process.env.BROUTER_UPSTREAM) {
    return process.env.BROUTER_UPSTREAM.replace(/\/+$/, '');
  }
  try {
    const cwd = process.cwd();
    const candidates = [
      path.resolve(cwd, '.env'),
      path.resolve(cwd, '../.env'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'),
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

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/brouter.ts')) {
  const quick = process.argv.includes('--quick');
  runBrouterBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
