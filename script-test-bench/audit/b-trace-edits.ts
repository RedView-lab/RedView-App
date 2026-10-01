/**
 * Audit B1 + B2 — routing-effect races, reproduced with the app's REAL pure
 * functions (traceEdits, timelineMutations, projectMutations, routeSegments).
 *
 *   npx tsx script-test-bench/audit/b-trace-edits.ts
 *
 * The React effect in hooks/useItineraryBrouterRouting/index.ts is simulated
 * faithfully: its dependency list includes `pendingRoutePatchKey`,
 * `pendingTraceExtensionKey`, `gpxRoutePointCount`, `gpxRouteSource`; any change
 * re-runs the effect, whose cleanup calls `ctrl.abort()` on the request (and the
 * IGN refinement that awaits the same signal).
 *
 * Scenarios
 *  B1  "IGN refinement never lands": after the first (BRouter-elevation) apply,
 *      the deps change → cleanup aborts the refinement; and even if it weren't
 *      aborted, the 2nd apply is a no-op because the pending field is cleared.
 *  B2a "rapid trace clicks": click B then C before B's segment resolves →
 *      pendingTraceExtension is overwritten, A→B is never routed and the final
 *      route contains a straight unrouted jump A→B.
 *  B2b "two quick drags of adjacent points": the 2nd pendingRoutePatch replaces
 *      the 1st; the segment around the 1st moved point is never re-routed.
 *
 * Exit 1 when any defect reproduces.
 */
import { loadSrc, closeLoader } from './b-loader';

type P = { lat: number; lon: number };
const failures: string[] = [];

function hav(a: P, b: P) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Synthetic but well-formed BRouter route (geojson + messages) through the given points. */
function fakeBrouterRoute(points: P[], stepM = 40, eleBase = 800) {
  const coords: [number, number, number][] = [];
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s], b = points[s + 1];
    const n = Math.max(2, Math.ceil(hav(a, b) / stepM));
    for (let i = s === 0 ? 0 : 1; i <= n; i++) {
      const t = i / n;
      // small lateral wiggle so the geometry is "road-like" and not a straight line
      const wig = Math.sin(t * Math.PI * 6) * 0.0004;
      const lat = a.lat + (b.lat - a.lat) * t + wig, lon = a.lon + (b.lon - a.lon) * t - wig;
      coords.push([lon, lat, eleBase + 100 * Math.sin(coords.length / 50)]);
    }
  }
  const header = ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'];
  const messages: unknown[][] = [header];
  let total = 0;
  for (let i = 0; i < coords.length; i += 5) {
    const d = i === 0 ? 0 : hav({ lat: coords[i - 5][1], lon: coords[i - 5][0] }, { lat: coords[i][1], lon: coords[i][0] });
    total += d;
    messages.push([Math.round(coords[i][0] * 1e6), Math.round(coords[i][1] * 1e6), Math.round(coords[i][2]), Math.round(d), 1000, 0, 0, 0, 0, 'highway=tertiary surface=asphalt', '', 0, 0]);
  }
  return {
    coordinates: coords as unknown as [number, number][],
    distanceM: total, durationS: total / 5, ascentM: 100, descentM: 100,
    raw: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { 'track-length': String(Math.round(total)), messages } }] },
  };
}

/** The subset of the routing effect's deps that project mutations can change. */
function effectDeps(it: any) {
  return JSON.stringify([
    it?.pendingRoutePatch ? JSON.stringify(it.pendingRoutePatch) : '',
    it?.pendingTraceExtension ? JSON.stringify(it.pendingTraceExtension) : '',
    it?.gpxRoute?.points.length ?? 0,
    it?.gpxRoute?.source ?? '',
  ]);
}

function maxGapM(points: P[]) {
  let max = 0, at = -1;
  for (let i = 1; i < points.length; i++) { const d = hav(points[i - 1], points[i]); if (d > max) { max = d; at = i; } }
  return { max, at };
}

async function main() {
  const trace = await loadSrc<any>('src/features/itineraryPanel/lib/tracer/traceEdits.ts');
  const mut = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/projectMutations.ts');
  const tl = await loadSrc<any>('src/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations.ts');
  // Routing effect's decision for a pending edit, given the previous unapplied one (index.ts).
  const { planPendingRouteEdit } = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/pendingEditPlan.ts');

  const S: P = { lat: 45.90, lon: 6.10 };
  const A: P = { lat: 45.93, lon: 6.16 };
  const B: P = { lat: 45.96, lon: 6.22 };
  const C: P = { lat: 45.99, lon: 6.28 };

  const baseProject = () => {
    const r = fakeBrouterRoute([S, A]);
    const pts = r.coordinates.map((c: any, i: number, arr: any[]) => ({ lat: c[1], lon: c[0], elevationM: c[2], distanceM: i === 0 ? 0 : undefined }));
    let d = 0; for (let i = 1; i < pts.length; i++) { d += hav(pts[i - 1], pts[i]); pts[i].distanceM = d; }
    const itinerary = {
      id: 'it-1', name: 'Trace', profileId: 'road', discipline: 'road',
      priorities: { tranquility: 50, elevation: 50, distance: 50, duration: 50 },
      roadTypes: { road: 'tolerate', gravel: 'tolerate', singletrack: 'tolerate', offroad: 'tolerate', bikeLanes: 'tolerate', majorRoads: 'tolerate', ferry: 'tolerate', turns: 'tolerate', cities: 'tolerate' },
      timeline: [
        { id: 'start', kind: 'start', label: 'S', distanceKm: 0, lat: S.lat, lon: S.lon },
        { id: 'end', kind: 'end', label: 'A', distanceKm: d / 1000, lat: A.lat, lon: A.lon },
      ],
      gpxRoute: { name: null, points: pts, originalPoints: pts, source: 'brouter', gpxQuality: 'default', gpxQualityPointsPerKm: null },
      metrics: { distanceKm: d / 1000 },
    };
    return { id: 'p', name: 'p', activeItineraryId: 'it-1', itineraries: [itinerary] } as any;
  };

  // ---------------- B1: refinement after a trace append -----------------
  {
    let project = baseProject();
    const copy = structuredClone(project.itineraries[0]);
    trace.applyTraceAppend(copy, { ...B, label: 'B' });
    project = { ...project, itineraries: [copy] };
    const pending = copy.pendingTraceExtension;
    const target = { itineraryId: 'it-1', pendingKey: JSON.stringify(pending) };
    const route = fakeBrouterRoute([A, B]);
    const depsBefore = effectDeps(project.itineraries[0]);
    // index.ts:368 — first apply with BRouter-native elevation
    const p1 = mut.applyPendingTraceAppend(project, target, route, null);
    const depsAfter = effectDeps(p1.itineraries[0]);
    const effectReruns = depsBefore !== depsAfter; // → cleanup at index.ts:399 aborts ctrl
    // Refinement (index.ts refineRouteInBackground): own AbortController keyed on the
    // itinerary — an effect re-run does not abort it — and applied through
    // applyRefinedRouteProfile, matched on the refined route's geometry (the pending
    // field is already cleared by the 1st apply).
    const fakeRefinedProfile = route.coordinates.map((c: any, i: number) => ({ lat: c[1], lon: c[0], distanceM: i * 40, elevationM: 1234, gradientPct: 0 }));
    const refinedLanded = (before: any, after: any) => after !== before
      && after.itineraries[0].gpxRoute.points.some((pt: any) => Math.abs((pt.elevationM ?? 0) - 1234) < 1);
    const base1 = mut.captureRouteRefinementBase(project, p1, 'it-1');
    const p2 = mut.applyRefinedRouteProfile(p1, base1, (bp: any) => mut.applyPendingTraceAppend(bp, target, route, fakeRefinedProfile));
    console.log(`B1 append: effect deps change after 1st apply=${effectReruns} (refinement has its own controller); refined elevations applied=${refinedLanded(p1, p2)}`);
    if (!refinedLanded(p1, p2)) failures.push('B1: IGN altimetry refinement not applied after a trace append');

    // same for drag patch
    let pp = baseProject();
    const c2 = structuredClone(pp.itineraries[0]);
    trace.moveTracePointInItinerary(c2, 'end', B.lon, B.lat);
    c2.pendingRoutePatch = tl.buildPendingRoutePatchForEditedRow(c2.timeline, 'end');
    pp = { ...pp, itineraries: [c2] };
    const tgt = { itineraryId: 'it-1', pendingKey: JSON.stringify(c2.pendingRoutePatch) };
    const r2 = fakeBrouterRoute([S, B]);
    const q1 = mut.applyPendingRoutePatch(pp, tgt, r2, null);
    const q2 = mut.applyRefinedRouteProfile(q1, mut.captureRouteRefinementBase(pp, q1, 'it-1'), (bp: any) => mut.applyPendingRoutePatch(bp, tgt, r2, fakeRefinedProfile));
    console.log(`B1 patch : refined elevations applied=${refinedLanded(q1, q2)}`);
    if (!refinedLanded(q1, q2)) failures.push('B1: IGN altimetry refinement not applied after a drag patch');

    // full recompute
    const pr = baseProject();
    pr.itineraries[0].gpxRoute.source = 'gpx';
    pr.itineraries[0].timeline.splice(1, 0, { id: 'w', kind: 'waypoint', label: 'w', distanceKm: null, lat: B.lat, lon: B.lon });
    const sig = mut.getRoutingInputsSignature(pr.itineraries[0]);
    const r3 = fakeBrouterRoute([S, B, A]);
    const rtgt = { itineraryId: 'it-1', inputsSignature: sig };
    const s1 = mut.applyRecomputedRoute(pr, rtgt, r3, null);
    const s2 = mut.applyRefinedRouteProfile(s1, mut.captureRouteRefinementBase(pr, s1, 'it-1'), (bp: any) => mut.applyRecomputedRoute(bp, rtgt, r3, fakeRefinedProfile));
    console.log(`B1 recompute: refined elevations applied=${refinedLanded(s1, s2)}`);
    if (!refinedLanded(s1, s2)) failures.push('B1: IGN altimetry refinement not applied after a full recompute');

    // stale refinement (route replaced meanwhile) must be ignored
    const replaced = mut.applyRecomputedRoute(pr, rtgt, fakeBrouterRoute([S, { lat: 45.95, lon: 6.0 }, B, A]), null);
    const stale = mut.applyRefinedRouteProfile(replaced, mut.captureRouteRefinementBase(pr, s1, 'it-1'), (bp: any) => mut.applyRecomputedRoute(bp, rtgt, r3, fakeRefinedProfile));
    if (stale !== replaced) failures.push('B1: stale refinement applied over a newer route');
  }

  // ---------------- B2a: rapid clicks (append) -----------------
  {
    let project = baseProject();
    const c1 = structuredClone(project.itineraries[0]);
    trace.applyTraceAppend(c1, { ...B, label: 'B' }); // click 1
    project = { ...project, itineraries: [c1] };
    const firstExt = c1.pendingTraceExtension;
    const c2 = structuredClone(project.itineraries[0]);
    trace.applyTraceAppend(c2, { ...C, label: 'C' }); // click 2 before segment A→B resolves
    project = { ...project, itineraries: [c2] };
    const secondExt = c2.pendingTraceExtension;
    console.log(`B2a pending after click1 = ${JSON.stringify(firstExt)}\n    pending after click2 = ${JSON.stringify(secondExt)}`);
    // effect ran for click 1 (request A→B, still unresolved), then re-runs for click 2
    const plan1 = planPendingRouteEdit(c1, undefined);
    const unresolved = { kind: 'append', pendingKey: plan1.pendingKey, append: { from: plan1.from, via: plan1.via, to: plan1.to } };
    const plan2 = planPendingRouteEdit(c2, unresolved);
    console.log(`    effect plan after click2 = ${plan2.mode} from ${JSON.stringify(plan2.from)} via ${JSON.stringify(plan2.via)} to ${JSON.stringify(plan2.to)}`);
    const route = plan2.mode === 'append' ? fakeBrouterRoute([plan2.from, ...plan2.via, plan2.to]) : fakeBrouterRoute([B, C]);
    const out = mut.applyPendingTraceAppend(project, { itineraryId: 'it-1', pendingKey: plan2.pendingKey ?? JSON.stringify(secondExt) }, route, null);
    const pts = out.itineraries[0].gpxRoute.points;
    const gap = maxGapM(pts);
    const viaKey = mut.getRoutingEndpointsKey(out.itineraries[0]).viaKey;
    console.log(`    final route: ${pts.length} pts, largest gap between consecutive points = ${gap.max.toFixed(0)} m at index ${gap.at} (A→B straight line = ${hav(A, B).toFixed(0)} m)`);
    console.log(`    pendingTraceExtension cleared=${out.itineraries[0].pendingTraceExtension === undefined}; viaKey now "${viaKey}" — index.ts:369 stores routingInputKey for these inputs → no full recompute repairs it`);
    if (gap.max > 1000) failures.push(`B2a: rapid trace clicks leave an unrouted straight segment of ${gap.max.toFixed(0)} m (A→B) marked as routed`);
  }

  // ---------------- B2b: two quick drags of adjacent points -----------------
  {
    let project = baseProject();
    // route S → A → B with A a waypoint
    const r = fakeBrouterRoute([S, A, B]);
    const it0 = project.itineraries[0];
    const pts = r.coordinates.map((c: any) => ({ lat: c[1], lon: c[0], elevationM: c[2] }));
    let d = 0; (pts[0] as any).distanceM = 0; for (let i = 1; i < pts.length; i++) { d += hav(pts[i - 1], pts[i]); (pts[i] as any).distanceM = d; }
    it0.gpxRoute.points = pts; it0.gpxRoute.originalPoints = pts;
    it0.timeline = [
      { id: 'start', kind: 'start', label: 'S', distanceKm: 0, lat: S.lat, lon: S.lon },
      { id: 'wA', kind: 'waypoint', label: 'A', distanceKm: 6, lat: A.lat, lon: A.lon, onRoute: true },
      { id: 'end', kind: 'end', label: 'B', distanceKm: d / 1000, lat: B.lat, lon: B.lon },
    ];
    const A2: P = { lat: 45.90, lon: 6.20 }; // A dragged far south-east
    const B2: P = { lat: 45.97, lon: 6.30 };
    const c1 = structuredClone(it0);
    trace.moveTracePointInItinerary(c1, 'wA', A2.lon, A2.lat);
    c1.pendingRoutePatch = tl.buildPendingRoutePatchForEditedRow(c1.timeline, 'wA');
    const c2 = structuredClone(c1);
    trace.moveTracePointInItinerary(c2, 'end', B2.lon, B2.lat); // 2nd drag before 1st result
    c2.pendingRoutePatch = tl.buildPendingRoutePatchForEditedRow(c2.timeline, 'end');
    project = { ...project, itineraries: [c2] };
    console.log(`B2b patch1=${JSON.stringify(c1.pendingRoutePatch)}\n    patch2=${JSON.stringify(c2.pendingRoutePatch)} (patch1 lost)`);
    const plan1 = planPendingRouteEdit(c1, undefined);
    const plan2 = planPendingRouteEdit(c2, { kind: 'patch', pendingKey: plan1.pendingKey });
    console.log(`    effect plan after 2nd drag = ${plan2.mode}`);
    const out = plan2.mode === 'full'
      ? mut.applyRecomputedRoute(project, { itineraryId: 'it-1', inputsSignature: mut.getRoutingInputsSignature(c2) }, fakeBrouterRoute([S, A2, B2]), null)
      : mut.applyPendingRoutePatch(project, { itineraryId: 'it-1', pendingKey: JSON.stringify(c2.pendingRoutePatch) }, fakeBrouterRoute([A2, B2]), null);
    if (out.itineraries[0].pendingRoutePatch) failures.push('B2b: pending patch left after the route was recomputed');
    const outPts: P[] = out.itineraries[0].gpxRoute.points;
    // does the final route pass near the NEW position of A (A2)? and near the OLD one (A)?
    const near = (p: P) => Math.min(...outPts.map((q) => hav(p, q)));
    const gap = maxGapM(outPts);
    console.log(`    final route: min dist to new A2 = ${near(A2).toFixed(0)} m, to old A = ${near(A).toFixed(0)} m, largest gap ${gap.max.toFixed(0)} m`);
    if (near(A) < 100 && gap.max > 1000) failures.push(`B2b: after two quick drags the route still goes through the OLD waypoint position and jumps ${gap.max.toFixed(0)} m straight to the new one`);
  }

  console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nOK');
  await closeLoader();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await closeLoader(); process.exit(2); });
