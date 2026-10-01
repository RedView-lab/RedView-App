/**
 * Audit B7 — silent via-point truncation in the full BRouter recompute.
 *
 *   npx tsx script-test-bench/audit/b-via-limit.ts
 *
 * hooks/useItineraryBrouterRouting/index.ts:458 does `userVia.slice(0, 14)`
 * with no warning. Every Tracer click after the 2nd turns the previous end into
 * a `waypoint` WITHOUT `onRoute` (traceEdits.ts:114-119), so it counts as a via
 * in getRoutingEndpointsKey. A traced route with >15 clicks is fine while it is
 * built segment by segment (pendingTraceExtension), but the first FULL
 * recompute (profile slider / road-type change, discipline switch, forbidden
 * zone, undo to a stale stamp…) routes only start + 14 vias + end: every later
 * click is silently skipped and the route shortcuts straight to the end.
 *
 * Exit 1 when vias are dropped without the user being told.
 */
import { loadSrc, closeLoader } from './b-loader';

async function main() {
  const trace = await loadSrc<any>('src/features/itineraryPanel/lib/tracer/traceEdits.ts');
  const mut = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/projectMutations.ts');
  const { buildBrouterUrl } = await loadSrc<any>('src/features/itineraryPanel/lib/brouter/index.ts');

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
    // after the first routed segment the route source is brouter (segment-by-segment appends)
    if (i === 1) it.gpxRoute = { points: [{ lat: 45, lon: 6 }, { lat: 45.02, lon: 6.02 }], source: 'brouter' };
  }
  const { startKey, endKey, viaKey } = mut.getRoutingEndpointsKey(it);
  const userVia = viaKey ? viaKey.split('|') : [];
  const via = userVia.slice(0, 14); // index.ts:458
  const url = buildBrouterUrl({
    start: { lon: +startKey.split(',')[0], lat: +startKey.split(',')[1] },
    end: { lon: +endKey.split(',')[0], lat: +endKey.split(',')[1] },
    via: via.map((s: string) => ({ lon: +s.split(',')[0], lat: +s.split(',')[1] })),
    profile: 'trekking',
  });
  const lonlats = new URL('http://x' + url).searchParams.get('lonlats')!.split('|').length;
  console.log(`${clicks} tracer clicks → timeline waypoints (not onRoute) = ${userVia.length}; full recompute sends ${lonlats} points (start + ${via.length} via + end); dropped = ${userVia.length - via.length}`);
  console.log(`dropped points: ${userVia.slice(14).join(' | ')}`);
  const dropped = userVia.length - via.length;
  console.log(dropped > 0 ? '\nFAIL: vias silently dropped by the full recompute (no warning, route shortcuts to the end)' : '\nOK');
  await closeLoader();
  process.exit(dropped > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
