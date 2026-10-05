/**
 * Route continuity bench — aucune ligne droite après une édition du tracé.
 *
 *   npx tsx script-test-bench/route-continuity/run.ts [--filter grenoble] [--verbose]
 *
 * Pré-requis : tunnel vers le BRouter du VPS (cf. routing-quality/run.ts)
 *   ssh -i ~/.ssh/oracle_brouter.key -N -L 27777:127.0.0.1:17777 opc@141.145.220.99
 *
 * Sur de vrais tracés (montagne, plaine, boucle, long tracé ancré) routés par
 * le vrai pipeline de l'app (client + api/brouter.ts + BRouter de prod), chaque
 * édition est rejouée comme le fait l'effet de routage : départ / arrivée
 * déplacés (sur le tracé = rognage, hors du tracé = patch), point inséré en
 * tirant le tracé, étape déplacée / supprimée, zone interdite, extension,
 * import GPX à trous. Contrôle : chaque mètre du tracé obtenu suit le tracé
 * d'origine ou un tracé renvoyé par BRouter (à 20 m près : lissage), sauf des
 * jonctions de moins de 25 m. Une ligne droite inventée échoue (code ≠ 0).
 */
import { closeLoader, loadSrc } from '../audit/b-loader.ts';
import { buildItinerary, loadApp } from '../routing-quality/app.ts';
import { installProxyShim } from '../routing-quality/proxy-shim.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Pt = { lat: number; lon: number };

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const verbose = process.argv.includes('--verbose');

const EARTH_R = 6_371_008.8;
function hav(a: Pt, b: Pt): number {
  const t = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * t) / 2) ** 2
    + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(((b.lon - a.lon) * t) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}
function offset(p: Pt, eastM: number, northM: number): Pt {
  return { lat: p.lat + northM / 111_195, lon: p.lon + eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}

/**
 * Géométries « sources » (tracé d'origine, réponses BRouter) indexées par
 * grille : un tracé obtenu doit en suivre une à `CORRIDOR_M` près partout.
 */
const CORRIDOR_M = 20;
const SEAM_M = 25;
class SourceIndex {
  private cells = new Map<string, Array<[Pt, Pt]>>();
  private readonly cellDeg = 0.003;
  add(points: ReadonlyArray<Pt>) {
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const minLat = Math.min(a.lat, b.lat) - 0.0004;
      const maxLat = Math.max(a.lat, b.lat) + 0.0004;
      const minLon = Math.min(a.lon, b.lon) - 0.0006;
      const maxLon = Math.max(a.lon, b.lon) + 0.0006;
      for (let x = Math.floor(minLon / this.cellDeg); x <= Math.floor(maxLon / this.cellDeg); x += 1) {
        for (let y = Math.floor(minLat / this.cellDeg); y <= Math.floor(maxLat / this.cellDeg); y += 1) {
          const key = `${x}:${y}`;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push([a, b]);
        }
      }
    }
  }
  distanceM(p: Pt): number {
    const list = this.cells.get(`${Math.floor(p.lon / this.cellDeg)}:${Math.floor(p.lat / this.cellDeg)}`) ?? [];
    let best = Number.POSITIVE_INFINITY;
    const k = Math.cos((p.lat * Math.PI) / 180);
    for (const [a, b] of list) {
      const dx = (b.lon - a.lon) * k;
      const dy = b.lat - a.lat;
      const px = (p.lon - a.lon) * k;
      const py = p.lat - a.lat;
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(px - t * dx, py - t * dy) * 111_195);
    }
    return best;
  }
}

interface Violation { atKm: number; stepM: number; offM: number }
/** Pas du tracé qui s'écartent des sources (ligne droite inventée). */
function findInventedLines(points: ReadonlyArray<Pt>, sources: SourceIndex): Violation[] {
  const violations: Violation[] = [];
  let alongM = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const stepM = hav(a, b);
    if (stepM > SEAM_M) {
      const samples = Math.ceil(stepM / 10);
      let worst = 0;
      for (let s = 0; s <= samples; s += 1) {
        const f = s / samples;
        worst = Math.max(worst, sources.distanceM({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }));
      }
      if (worst > CORRIDOR_M) violations.push({ atKm: Math.round(alongM / 100) / 10, stepM: Math.round(stepM), offM: Math.round(worst) });
    }
    alongM += stepM;
  }
  return violations;
}

const ROUTES: Array<{ id: string; label: string; start: Pt; end: Pt; via?: Pt[]; config: { activity: string; mode: string } }> = [
  { id: 'grenoble-briancon', label: 'Grenoble → Briançon (montagne)', start: { lat: 45.1885, lon: 5.7245 }, end: { lat: 44.8986, lon: 6.643 }, config: { activity: 'road', mode: 'vitesse' } },
  { id: 'paris-rouen', label: 'Paris → Rouen (plaine)', start: { lat: 48.8566, lon: 2.3522 }, end: { lat: 49.4432, lon: 1.0999 }, config: { activity: 'gravel', mode: 'aventure' } },
  {
    id: 'annecy-loop',
    label: 'Tour du lac d’Annecy (boucle, étapes)',
    start: { lat: 45.8992, lon: 6.1294 },
    end: { lat: 45.8992, lon: 6.1294 },
    via: [{ lat: 45.8436, lon: 6.2134 }, { lat: 45.7963, lon: 6.2204 }, { lat: 45.8306, lon: 6.1757 }],
    config: { activity: 'road', mode: 'vitesse' },
  },
  { id: 'lyon-marseille', label: 'Lyon → Marseille (long, ancres)', start: { lat: 45.764, lon: 4.8357 }, end: { lat: 43.2965, lon: 5.3698 }, config: { activity: 'road', mode: 'vitesse' } },
];

async function main() {
  const filter = arg('filter');
  const upstream = (process.env.BENCH_BROUTER_UPSTREAM ?? 'http://127.0.0.1:27777').replace(/\/+$/, '');
  process.env.BROUTER_UPSTREAM = upstream;
  const health = await fetch(`${upstream}/brouter?lonlats=5.72,45.18|5.75,45.2&profile=trekking&alternativeidx=0&format=geojson`).catch(() => null);
  if (!health?.ok) {
    console.error(`BRouter injoignable sur ${upstream} — tunnel SSH ouvert ?`);
    process.exit(2);
  }

  const app = await loadApp();
  const shim = installProxyShim(app.apiHandler, { maxConcurrent: 2 });
  const mutations = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/projectMutations.ts');
  const inputs = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/routingInputs.ts');
  const elastic = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRouting/elasticRoutePatch.ts');
  const shared = await loadSrc<any>('src/features/itineraryPanel/hooks/useItineraryBrouterRoutingShared/index.ts');
  const timeline = await loadSrc<any>('src/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations.ts');
  const forbidden = await loadSrc<any>('src/features/itineraryPanel/context/ProjectStore/forbiddenZonePatch.ts');
  const gaps = await loadSrc<any>('src/features/itineraryPanel/components/ItineraryPanelContainer/importedGpxGaps.ts');
  const gpxParse = await loadSrc<any>('src/features/poi/lib/gpx-parse.ts');
  const routes = await loadSrc<any>('src/features/itineraryPanel/lib/routes/index.ts');
  const defaults = await loadSrc<any>('src/features/itineraryPanel/lib/project/defaultState.ts');

  // Toutes les géométries renvoyées par BRouter pendant une édition.
  let routed: Pt[][] = [];
  const route = async (itinerary: any, requestBase: any) => {
    const ctrl = new AbortController();
    const res = await app.resolveRouteRequest({ itinerary, signal: ctrl.signal, requestBase: { ...requestBase, signal: ctrl.signal }, setRouteWarnings: () => {} });
    routed.push(res.route.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon })));
    return res;
  };

  /** Recalcul complet, comme l'effet de routage. */
  const recompute = async (project: any) => {
    const it = project.itineraries[0];
    const { start, end, via } = inputs.getRoutingEndpoints(it);
    const res = await route(it, { start, end, via, polygons: formatPolygons(it.forbiddenZones) });
    return mutations.applyRecomputedRoute(project, { itineraryId: it.id, inputsSignature: inputs.getRoutingInputsSignature(it) }, res.route, null);
  };

  /** Édition locale en attente (patch / extension), comme l'effet de routage. */
  const settle = async (project: any): Promise<{ project: any; path: string }> => {
    const it = project.itineraries[0];
    const points = it.gpxRoute.points;
    if (it.pendingRoutePatch) {
      const pending = it.pendingRoutePatch;
      try {
        const ctrl = new AbortController();
        const result = await elastic.resolveElasticRoutePatch(pending, points, ctrl.signal, (patch: any) => route(it, {
          start: shared.anchorRoutePatchBound(patch.start, points),
          end: shared.anchorRoutePatchBound(patch.end, points),
          via: patch.via,
          polygons: formatPolygons(it.forbiddenZones),
        }));
        const next = mutations.applyPendingRoutePatch(project, { itineraryId: it.id, pendingKey: JSON.stringify(pending) }, result.route, null, result.patch);
        if (next === project) throw new Error('patch not applied');
        return { project: next, path: result.patch.window ? 'patch (fenêtre)' : 'patch' };
      } catch (error) {
        if (!routes.isRouteSeamError(error)) throw error;
        return { project: await recompute(project), path: 'recalcul complet (jonction impossible)' };
      }
    }
    if (it.pendingTraceExtension) {
      const ext = it.pendingTraceExtension;
      const res = await route(it, { start: ext.from, end: ext.to, via: [] });
      const next = mutations.applyPendingTraceAppend(project, { itineraryId: it.id, pendingKey: JSON.stringify(ext) }, res.route, null);
      if (next === project) return { project: await recompute(project), path: 'recalcul complet (extension)' };
      return { project: next, path: 'extension' };
    }
    return { project, path: 'rognage (sans routage)' };
  };

  const brouterLib = await loadSrc<any>('src/features/itineraryPanel/lib/brouter/index.ts');
  const formatPolygons = (zones: any) => brouterLib.formatForbiddenZonePolygons(zones);

  let failures = 0;
  let checks = 0;
  const report = (routeId: string, edit: string, path: string, project: any, sources: SourceIndex) => {
    checks += 1;
    const it = project.itineraries[0];
    const points = it.gpxRoute.points as Pt[];
    const violations = findInventedLines(points, sources);
    const start = it.timeline.find((row: any) => row.kind === 'start');
    const end = it.timeline.find((row: any) => row.kind === 'end');
    const startGap = start?.lat != null ? hav(start, points[0]!) : 0;
    const endGap = end?.lat != null ? hav(end, points[points.length - 1]!) : 0;
    const ok = violations.length === 0;
    if (!ok) failures += 1;
    console.log(`${ok ? '✔' : '✘'} ${routeId} · ${edit} → ${path} · ${(points.length)} pts, ${(it.metrics?.distanceKm ?? 0).toFixed(1)} km, départ à ${Math.round(startGap)} m, arrivée à ${Math.round(endGap)} m${ok ? '' : ` · LIGNES DROITES: ${JSON.stringify(violations.slice(0, 5))}`}`);
  };

  for (const spec of ROUTES.filter((r) => !filter || new RegExp(filter).test(r.id))) {
    const itinerary = buildItinerary(app, spec.config as any);
    itinerary.timeline = [
      { id: 'start', kind: 'start', label: 'Départ', distanceKm: 0, ...spec.start },
      ...(spec.via ?? []).map((point, index) => ({ id: `wp${index + 1}`, kind: 'waypoint', label: `Étape ${index + 1}`, distanceKm: null, ...point })),
      { id: 'end', kind: 'end', label: 'Arrivée', distanceKm: null, ...spec.end },
    ];
    let base = { ...defaults.createDefaultProject(), itineraries: [itinerary], activeItineraryId: itinerary.id };
    routed = [];
    const t0 = performance.now();
    base = await recompute(base);
    const baseIt = base.itineraries[0];
    const basePoints = baseIt.gpxRoute.points as Pt[];
    const totalM = basePoints.reduce((sum, p, i) => (i ? sum + hav(basePoints[i - 1]!, p) : 0), 0);
    console.log(`\n${spec.label}: ${(totalM / 1000).toFixed(1)} km, ${basePoints.length} pts (${Math.round(performance.now() - t0)} ms)`);
    const cumulative = routes.cumulativeRouteLengthsM(basePoints);
    const pointAt = (fraction: number): Pt & { distanceM: number } => {
      const target = totalM * fraction;
      let i = 1;
      while (i < basePoints.length - 1 && cumulative[i]! < target) i += 1;
      const a = basePoints[i - 1]!;
      const b = basePoints[i]!;
      const f = (target - cumulative[i - 1]!) / Math.max(1e-9, cumulative[i]! - cumulative[i - 1]!);
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, distanceM: target };
    };

    const edits: Array<{ name: string; apply: (it: any) => void }> = [
      { name: 'Démarrer ici sur le tracé (30 %)', apply: (it) => { const p = pointAt(0.3); timeline.placeRouteEndpoint(it, 'start', p, 'Départ', { routeDistanceM: p.distanceM }); } },
      { name: 'Finir ici sur le tracé (65 %)', apply: (it) => { const p = pointAt(0.65); timeline.placeRouteEndpoint(it, 'end', p, 'Arrivée', { routeDistanceM: p.distanceM }); } },
      { name: 'Départ glissé hors du tracé (1,5 km)', apply: (it) => { const p = offset(pointAt(0.12), 1_500, 300); const row = it.timeline.find((r: any) => r.kind === 'start'); row.lat = p.lat; row.lon = p.lon; delete row.onRoute; it.pendingRoutePatch = timeline.buildPendingRoutePatchForEditedRow(it, row.id); } },
      { name: 'Arrivée glissée hors du tracé (2 km)', apply: (it) => { const p = offset(pointAt(0.9), -2_000, 0); const row = it.timeline.find((r: any) => r.kind === 'end'); row.lat = p.lat; row.lon = p.lon; it.pendingRoutePatch = timeline.buildPendingRoutePatchForEditedRow(it, row.id); } },
      {
        name: 'Tracé tiré à 50 % (1,2 km)',
        apply: (it) => {
          const anchor = pointAt(0.5);
          const drop = offset(anchor, 1_200, 0);
          const inserted = timeline.insertWaypointAtRoutePosition(it.timeline, basePoints, anchor, drop);
          it.pendingRoutePatch = timeline.buildPendingRoutePatchForEditedRow(it, inserted.newRowId, inserted.anchorDistanceM);
        },
      },
      {
        name: 'Zone interdite à 40 %',
        apply: (it) => {
          const c = pointAt(0.4);
          const zone = { id: 'fz', createdAt: '', points: [offset(c, -400, -400), offset(c, 400, -400), offset(c, 400, 400), offset(c, -400, 400)] };
          it.forbiddenZones = [zone];
          it.pendingRoutePatch = forbidden.buildPendingRoutePatchForForbiddenZone(it.timeline, it.gpxRoute.points, zone);
        },
      },
    ];
    if (spec.via?.length) {
      edits.push(
        { name: 'Étape 2 déplacée (800 m)', apply: (it) => { const row = it.timeline.find((r: any) => r.id === 'wp2'); const p = offset(row, 800, 0); row.lat = p.lat; row.lon = p.lon; it.pendingRoutePatch = timeline.buildPendingRoutePatchForEditedRow(it, row.id); } },
        {
          name: 'Étape 1 supprimée',
          apply: (it) => {
            const previous = it.timeline;
            it.timeline = timeline.buildTimelineAfterRemoval(it.timeline, 'wp1');
            timeline.setPendingRoutePatchAfterRemoval(it, previous);
          },
        },
      );
    }

    for (const edit of edits) {
      routed = [];
      const draft = structuredClone(base);
      edit.apply(draft.itineraries[0]);
      const tEdit = performance.now();
      try {
        const settled = await settle(draft);
        const sources = new SourceIndex();
        sources.add(basePoints);
        for (const geometry of routed) sources.add(geometry);
        report(spec.id, edit.name, `${settled.path}, ${Math.round(performance.now() - tEdit)} ms`, settled.project, sources);
      } catch (error) {
        failures += 1;
        console.log(`✘ ${spec.id} · ${edit.name} → erreur ${String(error).slice(0, 200)}`);
      }
    }

    if (spec.id === 'paris-rouen') {
      // Extension d'un tracé ouvert (traceur, sans arrivée) puis import GPX à trous.
      routed = [];
      const open = structuredClone(base);
      const it = open.itineraries[0];
      const endRow = it.timeline.find((r: any) => r.kind === 'end');
      it.timeline = [
        ...it.timeline.filter((r: any) => r.kind !== 'end'),
        { id: 'wp-end', kind: 'waypoint', label: 'Arrivée précédente', distanceKm: null, lat: endRow.lat, lon: endRow.lon },
        { id: 'end', kind: 'end', label: 'Rechercher un lieu', distanceKm: null },
      ];
      it.gpxRoute.routedInputsKey = inputs.getRoutingInputsSignature(it);
      const added = { lat: 49.48, lon: 1.0 };
      const inserted = timeline.insertWaypointIntoTimeline(it.timeline, added, it.gpxRoute.points, { label: 'Clic' });
      timeline.setPendingRouteEditForPlacedRow(it, inserted.newRow.id);
      const settled = await settle(open);
      const sources = new SourceIndex();
      sources.add(basePoints);
      for (const geometry of routed) sources.add(geometry);
      report(spec.id, 'Prolongé depuis la fin (tracé ouvert)', settled.path, settled.project, sources);

      // GPX : la trace d'origine coupée en deux segments, 12 km manquants entre eux.
      routed = [];
      const holeFrom = Math.floor(basePoints.length * 0.4);
      const holeTo = basePoints.findIndex((p, i) => i > holeFrom && cumulative[i]! - cumulative[holeFrom]! > 12_000);
      const trkpts = (pts: Pt[]) => pts.map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></trkpt>`).join('');
      const gpxText = `<gpx creator="bench"><trk><trkseg>${trkpts(basePoints.slice(0, holeFrom + 1))}</trkseg><trkseg>${trkpts(basePoints.slice(holeTo))}</trkseg></trk></gpx>`;
      const parsed = gpxParse.parseGpxText(gpxText);
      const bridged = await gaps.bridgeImportedGpxGaps(parsed);
      // Référence : le même raccord demandé ici (BRouter est déterministe).
      await route(defaults.createDefaultItinerary(), { start: parsed.points[holeFrom], end: parsed.points[holeFrom + 1], via: [] });
      checks += 1;
      const gpxSources = new SourceIndex();
      gpxSources.add(parsed.points.slice(0, holeFrom + 1));
      gpxSources.add(parsed.points.slice(holeFrom + 1));
      for (const geometry of routed) gpxSources.add(geometry);
      const violations = findInventedLines(bridged.route.points, gpxSources);
      const ok = violations.length === 0 && bridged.bridged === 1;
      if (!ok) failures += 1;
      console.log(`${ok ? '✔' : '✘'} ${spec.id} · import GPX à 2 segments (trou de 12 km) → ${bridged.bridged} raccord(s), ${bridged.unbridged} non relié(s), plus long pas ${Math.round(Math.max(...bridged.route.points.slice(1).map((p: Pt, i: number) => hav(bridged.route.points[i], p))))} m${ok ? '' : ` · ${JSON.stringify(violations.slice(0, 5))}`}`);
    }
    if (verbose) console.log(`  (requêtes BRouter : ${shim.log.length})`);
  }

  shim.restore();
  await closeLoader();
  console.log(`\n${checks - failures}/${checks} éditions sans ligne droite.`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
