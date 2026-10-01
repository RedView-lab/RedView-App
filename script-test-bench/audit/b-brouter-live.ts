/**
 * Audit B4 — BRouter through the PUBLIC prod proxy (https://app.redview.tech/api/brouter)
 * using the app's real routing pipeline:
 *   createDefaultItinerary → resolveItineraryRouting (BRF build + upload via
 *   profile-cache) → fetchRouteForPrioritiesWithFallback (14 s custom-profile
 *   timeout + stock fallback) → fetchBrouterRoute (api/url.ts URL builder).
 *
 *   npx tsx script-test-bench/audit/b-brouter-live.ts
 *
 * Budget: hard cap of 14 live requests, >= 3.1 s apart (shared 120 req/min/IP).
 * Reports latency, payload size, content-encoding, cache HIT, fallback use and
 * D+ coherence (BRouter "filtered ascend" vs the app's computeRouteElevationMetrics
 * vs the GPX the route was derived from).
 *
 * Exit 1 when a custom-profile request falls back (>14 s or refused) or a
 * route fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSrc, closeLoader, installLiveFetch, DOWNLOADS, type LiveLog } from './b-loader';

const failures: string[] = [];
const log: LiveLog[] = [];

async function main() {
  const live = installLiveFetch({ maxLive: 14, minGapMs: 3100, log });
  const defaults = await loadSrc<any>('src/features/itineraryPanel/lib/project/defaultState.ts');
  const brouter = await loadSrc<any>('src/features/itineraryPanel/lib/brouter/index.ts');
  const fallback = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/profileFallback.ts');
  const shared = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRoutingShared/index.ts');
  const metrics = await loadSrc<any>('src/features/itineraryPanel/lib/route-metrics/index.ts');
  const { parseGpxText } = await loadSrc<any>('src/features/poi/lib/gpx-parse.ts');
  const routes = await loadSrc<any>('src/features/itineraryPanel/lib/routes/index.ts');

  type P = { lat: number; lon: number };
  async function run(label: string, it: any, start: P, end: P, via: P[], ref?: { km: number; dplus: number }) {
    const t0 = performance.now();
    const before = log.length;
    let resolved: any;
    try {
      resolved = await brouter.resolveItineraryRouting(it);
      const { route, usedFallbackProfile } = await fallback.fetchRouteForPrioritiesWithFallback(
        { start, end, via }, it.priorities, resolved.profileId, resolved.stockProfileId,
      );
      const ms = performance.now() - t0;
      const pts = shared.buildStoredRoutePointsFromBrouter(shared.toGeometryRoutePoints(route.coordinates), metrics.extractRouteProfileFromBrouter(route), route.distanceM);
      const em = metrics.computeRouteElevationMetrics(pts);
      const calls = log.slice(before).map((l) => `${l.method} ${l.status} ${l.ms}ms ${(l.bytes / 1024).toFixed(0)}KB enc=${l.headers['content-encoding'] ?? 'none'} cache=${l.headers['x-route-cache'] ?? '-'}`);
      console.log(`\n[${label}] profile=${resolved.profileId} (stock ${resolved.stockProfileId}) brf=${resolved.brf ? resolved.brf.length + 'B' : 'none'} fallback=${usedFallbackProfile}`);
      console.log(`  total ${ms.toFixed(0)} ms | ${(route.distanceM / 1000).toFixed(1)} km | ${route.coordinates.length} coords | BRouter filtered ascend ${Math.round(route.ascentM)} m | app D+ ${em ? Math.round(em.ascentM) : '?'} m${ref ? ` | GPX ref ${ref.km} km / D+ ${ref.dplus} m` : ''}`);
      calls.forEach((c) => console.log('   ' + c));
      if (usedFallbackProfile) failures.push(`${label}: custom profile fell back to stock (timeout >14 s or refused)`);
      return route;
    } catch (e) {
      console.log(`\n[${label}] FAILED after ${(performance.now() - t0).toFixed(0)} ms: ${(e as Error).message.slice(0, 200)}`);
      log.slice(before).forEach((l) => console.log(`   ${l.method} ${l.status} ${l.ms}ms ${l.bytes}B`));
      failures.push(`${label}: ${(e as Error).message.slice(0, 120)}`);
      return null;
    }
  }

  const mk = (over: any = {}) => ({ ...defaults.createDefaultItinerary(1), ...over });
  const custom = (it: any) => ({ ...it, priorities: { ...it.priorities, elevation: 85, tranquility: 85 }, roadTypes: { ...it.roadTypes, gravel: 'prefer', majorRoads: 'avoid' } });

  // 1. Short alpine: Valloire → Col du Galibier (~18 km)
  const valloire = { lat: 45.1650, lon: 6.4290 }, galibier = { lat: 45.0640, lon: 6.4080 };
  await run('short default', mk(), valloire, galibier, []);
  await run('short custom', custom(mk()), valloire, galibier, []);
  await run('short foot (trail)', mk({ discipline: 'trail' }), valloire, galibier, []);

  // 2. ~200 km: re-route the Tour de France 2026 stage through 12 of its own track points
  const gpx = parseGpxText(fs.readFileSync(path.join(DOWNLOADS, 'Tour de France 2026.gpx'), 'utf8'));
  const stored = routes.normalizeImportedRoutePoints(gpx.points, { includeGradient: false });
  const m = routes.buildImportedRouteMetrics(stored);
  const via = Array.from({ length: 12 }, (_, i) => stored[Math.round(((i + 1) / 13) * (stored.length - 1))]).map((p: any) => ({ lat: p.lat, lon: p.lon }));
  await run('TdF stage default', mk(), stored[0], stored[stored.length - 1], via, { km: m.distanceKm, dplus: m.ascentM });
  await run('TdF stage custom', custom(mk()), stored[0], stored[stored.length - 1], via, { km: m.distanceKm, dplus: m.ascentM });

  // 3. Long ~1000 km: Paris → Bordeaux → Toulouse → Montpellier (2 long requests, 3rd only if fallback)
  const paris = { lat: 48.8566, lon: 2.3522 }, bordeaux = { lat: 44.8378, lon: -0.5792 }, toulouse = { lat: 43.6047, lon: 1.4442 }, montpellier = { lat: 43.6108, lon: 3.8767 };
  await run('long default', mk(), paris, montpellier, [bordeaux, toulouse]);
  await run('long custom', custom(mk()), paris, montpellier, [bordeaux, toulouse]);

  // 4. Server cache: same URL again after clearing the client-side cache module? The client
  //    cache (client.ts MAX_CLIENT_CACHE) would answer locally, so hit the URL directly.
  const url = brouter.buildBrouterUrl({ start: valloire, end: galibier, profile: 'trekking' });
  const r = await fetch(url);
  console.log(`\n[repeat short default, raw] ${r.status} x-route-cache=${r.headers.get('x-route-cache')} cache-control=${r.headers.get('cache-control')}`);

  console.log(`\nlive requests used: ${live.count}`);
  live.restore();
  console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nOK');
  await closeLoader();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
