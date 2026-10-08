/**
 * Audit B7 — troncature silencieuse des points de passage dans le recalcul
 * BRouter complet.
 *
 *   npx tsx script-test-bench/audit/b-via-limit.ts
 *
 * hooks/useItineraryBrouterRouting/index.ts:458 fait `userVia.slice(0, 14)`
 * sans avertissement. Chaque clic du Tracer après le 2e transforme la fin
 * précédente en `waypoint` SANS `onRoute` (traceEdits.ts:114-119), donc il
 * compte comme via dans getRoutingEndpointsKey. Une route tracée avec plus de
 * 15 clics tient tant qu'elle est construite segment par segment
 * (pendingTraceExtension), mais le premier recalcul COMPLET (curseur de profil
 * / changement de type de route, changement de discipline, zone interdite,
 * annulation vers un tampon périmé…) ne route que départ + 14 via + arrivée :
 * chaque clic suivant est sauté sans bruit et la route coupe tout droit vers
 * l'arrivée.
 *
 * Sortie 1 quand des via sont abandonnés sans que l'utilisateur en soit informé.
 */
import { loadSrc, closeLoader } from './b-loader';

async function main() {
  const trace = await loadSrc<any>('src/features/itineraryPanel/lib/tracer/traceEdits.ts');
  const mut = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/projectMutations.ts');
  const { splitRouteIntoLegs, MAX_BROUTER_VIA_PER_REQUEST } = await loadSrc<any>('src/features/itineraryPanel/lib/brouter/index.ts');

  const it: any = {
    id: 'it-1', timeline: [
      { id: 'start', kind: 'start', label: 's', distanceKm: 0 },
      { id: 'end', kind: 'end', label: 'e', distanceKm: null },
    ],
    gpxRoute: undefined, metrics: {},
  };
  const clicks = 25;
  for (let i = 0; i < clicks; i++) {
    const p = { lat: 45 + i * 0.02, lon: 6 + (i % 2) * 0.02, label: `c${i}` };
    trace.applyTraceAppend(it, p);
    // après le premier segment routé, la source de la route est brouter (ajouts segment par segment)
    if (i === 1) it.gpxRoute = { points: [{ lat: 45, lon: 6 }, { lat: 45.02, lon: 6.02 }], source: 'brouter' };
  }
  const { startKey, endKey, viaKey } = mut.getRoutingEndpointsKey(it);
  const toPoint = (s: string) => ({ lon: +s.split(',')[0], lat: +s.split(',')[1] });
  const userVia = viaKey ? viaKey.split('|').map(toPoint) : [];
  // Recalcul complet (index.ts → resolveRouteRequest) : tronçons d'au plus MAX_BROUTER_VIA_PER_REQUEST via.
  const legs = splitRouteIntoLegs(toPoint(startKey), userVia, toPoint(endKey));
  const routed = [legs[0].start, ...legs.flatMap((leg: any) => [...leg.via, leg.end])];
  const expected = [toPoint(startKey), ...userVia, toPoint(endKey)];
  const same = routed.length === expected.length && routed.every((p: any, i: number) => p.lat === expected[i].lat && p.lon === expected[i].lon);
  const maxVia = Math.max(...legs.map((leg: any) => leg.via.length));
  console.log(`${clicks} tracer clicks → timeline waypoints (not onRoute) = ${userVia.length}; full recompute = ${legs.length} leg(s), max ${maxVia} via/request (cap ${MAX_BROUTER_VIA_PER_REQUEST}); all points routed in order = ${same}`);
  const dropped = same && maxVia <= MAX_BROUTER_VIA_PER_REQUEST ? 0 : 1;
  console.log(dropped > 0 ? '\nFAIL: vias dropped / reordered by the full recompute' : '\nOK');
  await closeLoader();
  process.exit(dropped > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
