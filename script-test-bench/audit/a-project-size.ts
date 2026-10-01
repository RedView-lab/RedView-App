/**
 * Audit A — Taille de persistance d'un ItineraryProject réaliste (ultra / bikepacking).
 *
 * Utilise les VRAIES fonctions de l'app :
 *   - parseGpxText (features/poi/lib/gpx-parse.ts)
 *   - normalizeImportedRoutePoints / simplifyPointsByQuality / createImportedTimeline /
 *     buildImportedRouteMetrics (features/itineraryPanel/lib/routes) — même chaîne que
 *     useItineraryGpxImport.addItineraryFromGpxFile (sans l'appel réseau IGN)
 *   - createDefaultProject / createDefaultItinerary / normalizeItineraryProject
 *   - compressProjectPayload / decompressProjectPayload (shared/utils/projects/compression.ts)
 *   - computeProjectSizeBytes / isProjectTooLarge / MAX_PROJECT_SIZE_BYTES (limits.ts)
 *   - buildLocalProjectCachePayload (pages/Dashboard/dashboardProjectCache.ts)
 *
 * Mesure : JSON brut, gzip+base64 ('gz:' + base64) vs attribut Appwrite `projects.data`
 * (string size=1 000 000, vérifié en live par a-appwrite-schema-readonly.mjs), vs limite client
 * 16 MiB. Recherche la longueur de parcours max qui tient. Chronomètre les sérialisations
 * faites à CHAQUE autosave.
 *
 * Usage : npx tsx script-test-bench/audit/a-project-size.ts [--gpx-dir <dir>] [--json out.json]
 * Exit 1 si un projet ultra réaliste passe la limite client mais dépasse la limite Appwrite.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  createDefaultItinerary,
  createDefaultProject,
  createImportedPoiState,
  normalizeItineraryProject,
} from '../../src/features/itineraryPanel/lib/project/index.ts';
import { parseGpxText } from '../../src/features/poi/lib/gpx-parse.ts';
import {
  buildImportedRouteMetrics,
  createImportedTimeline,
  normalizeImportedRoutePoints,
  simplifyPointsByQuality,
} from '../../src/features/itineraryPanel/lib/routes/index.ts';
import {
  compressProjectPayload,
  decompressProjectPayload,
} from '../../src/shared/utils/projects/compression.ts';
import {
  computeProjectSizeBytes,
  isProjectTooLarge,
  MAX_PROJECT_SIZE_BYTES,
} from '../../src/shared/utils/projects/limits.ts';
import type { Itinerary, ItineraryProject, TimelineItem } from '../../src/features/itineraryPanel/types.ts';
import type { PoiCategory, PoiFeature } from '../../src/features/poi/types.ts';
import type { PredictionResult } from '../../src/features/fitPredictor/types.ts';

/** Attribut `projects.data` (scripts/setup-appwrite-schema.mjs, relevé à 16 000 000 en prod le 2026-10-01). */
const APPWRITE_DATA_MAX_CHARS = 16_000_000;

const args = process.argv.slice(2);
const argVal = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const GPX_DIR = argVal('--gpx-dir') ?? path.join(os.homedir(), 'Downloads');
const JSON_OUT = argVal('--json');

type RoutePoint = NonNullable<Itinerary['gpxRoute']>['points'][number];

// ── Générateur pseudo-aléatoire déterministe ─────────────────────────────
let seed = 42;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// ── Construction d'un itinéraire comme useItineraryGpxImport ─────────────
const SURFACES = ['asphalt', 'asphalt', 'asphalt', 'paved', 'gravel', 'dirt', 'unknown'] as const;

function withSurfaces(points: RoutePoint[]): RoutePoint[] {
  // Simule analyzeGpxSurfaces : surface par tronçons de ~40 points
  let current: RoutePoint['surface'] = 'asphalt';
  return points.map((p, i) => {
    if (i % 40 === 0) current = SURFACES[Math.floor(rnd() * SURFACES.length)];
    return { ...p, surface: current };
  });
}

function buildItineraryFromPoints(
  name: string,
  rawPoints: RoutePoint[],
  index: number,
  opts: { pois: number; prediction: boolean },
): Itinerary {
  const storedPoints = withSurfaces(normalizeImportedRoutePoints(rawPoints, { includeGradient: false }));
  const simplifiedPoints = normalizeImportedRoutePoints(simplifyPointsByQuality(storedPoints, 'default'));
  const base = createDefaultItinerary(index);
  const timeline = createImportedTimeline(storedPoints);
  const totalM = storedPoints[storedPoints.length - 1]?.distanceM ?? 0;

  const poiFeatures = buildPois(storedPoints, opts.pois);
  // ~6 % des POI deviennent des favoris / lignes de timeline (tri auto)
  const favRows: TimelineItem[] = poiFeatures
    .filter((_, i) => i % 16 === 0)
    .map((poi, i) => ({
      id: `poi-${poi.id}`,
      kind: 'poi',
      label: poi.name ?? 'POI',
      distanceKm: Math.round(((i + 1) / (opts.pois / 16 + 1)) * totalM) / 1000,
      durationMin: 10,
      favorite: true,
      visible: true,
      lat: poi.lat,
      lon: poi.lon,
      onRoute: true,
      poiCategory: poi.category,
      osmId: poi.id,
      favoriteSource: 'auto',
      autoReason: 'water',
    }) as TimelineItem);

  return {
    ...base,
    id: `it-audit-${index}`,
    name,
    gpxRoute: {
      name,
      points: simplifiedPoints,
      originalPoints: storedPoints,
      gpxQuality: 'default',
      gpxQualityPointsPerKm: null,
      source: 'gpx',
    },
    timeline: [...timeline, ...favRows],
    metrics: buildImportedRouteMetrics(storedPoints),
    poi: createImportedPoiState(),
    poiFeatures,
    prediction: opts.prediction ? buildPrediction(storedPoints) : null,
    fitUploads: Array.from({ length: 5 }, (_, i) => ({
      name: `ride-${i}.fit`,
      type: 'application/octet-stream',
      lastModified: 1_700_000_000_000 + i,
      size: 800_000 + i,
      path: `user/it-audit-${index}/ride-${i}.fit`,
    })),
    rhythmConfigured: opts.prediction,
  };
}

const POI_CATS: PoiCategory[] = [
  'drinking_water', 'toilets', 'supermarket', 'convenience', 'bakery', 'fountain', 'bicycle',
  'hospital', 'shower', 'water_point', 'spring', 'butcher',
];

function buildPois(points: RoutePoint[], count: number): PoiFeature[] {
  const out: PoiFeature[] = [];
  for (let i = 0; i < count; i++) {
    const p = points[Math.floor((i / Math.max(1, count)) * (points.length - 1))];
    const cat = POI_CATS[i % POI_CATS.length];
    const tags: Record<string, string> = {
      amenity: String(cat),
      name: `POI ${cat} ${i}`,
    };
    if (rnd() < 0.6) tags.opening_hours = 'Mo-Sa 07:00-19:30; Su 08:00-12:30';
    if (rnd() < 0.3) tags.website = `https://www.example-${i}.fr/`;
    if (rnd() < 0.3) tags.phone = `+33 4 ${String(10_000_000 + i).slice(0, 8)}`;
    if (rnd() < 0.5) tags['addr:city'] = 'Saint-Jean-de-Maurienne';
    if (rnd() < 0.4) tags['addr:street'] = 'Avenue du Général de Gaulle';
    out.push({
      id: 100_000_000 + i * 7919,
      lat: p.lat + (rnd() - 0.5) * 0.01,
      lon: p.lon + (rnd() - 0.5) * 0.01,
      category: cat,
      name: tags.name,
      tags,
      osmType: 'node',
      source: null,
      srcConfidence: null,
    });
  }
  return out;
}

function buildPrediction(points: RoutePoint[]): PredictionResult {
  const totalM = points[points.length - 1]?.distanceM ?? 0;
  // container-prediction.ts:8-10 : 250 m, min 4000, max 8000 points
  const n = Math.max(4000, Math.min(8000, Math.ceil(totalM / 250)));
  const pts = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const src = points[Math.floor((i / (n - 1)) * (points.length - 1))];
    const speed = 18 + rnd() * 12;
    const seg = (totalM / n) / (speed / 3.6);
    t += seg;
    pts.push({
      distance_m: (totalM * i) / (n - 1),
      elevation_m: src.elevationM ?? 0,
      gradient_pct: (rnd() - 0.5) * 16,
      predicted_speed_kmh: speed,
      predicted_power_w: 150 + rnd() * 120,
      elapsed_time_s: t,
      segment_time_s: seg,
      fatigue_factor: 0.9 + rnd() * 0.1,
      circadian_factor: 0.95 + rnd() * 0.05,
      distance_eff_factor: 0.97 + rnd() * 0.03,
      knn_confidence: rnd(),
      predicted_speed_low_kmh: speed * 0.9,
      predicted_speed_high_kmh: speed * 1.1,
    });
  }
  return {
    total_time_s: t,
    riding_time_s: t * 0.9,
    stop_time_s: t * 0.1,
    total_distance_m: totalM,
    avg_speed_kmh: 22,
    elevation_gain_m: 30000,
    elevation_loss_m: 30000,
    segments: Array.from({ length: 200 }, (_, i) => ({
      start_distance_m: (totalM * i) / 200,
      end_distance_m: (totalM * (i + 1)) / 200,
      distance_m: totalM / 200,
      elevation_gain_m: 120,
      elevation_loss_m: 110,
      avg_gradient_pct: 1.2,
      avg_speed_kmh: 22,
      time_s: 1000,
      segment_type: 'climb',
      vam_mh: 800,
    })),
    points: pts,
    discipline: 'bike',
    total_time_low_s: t * 0.92,
    total_time_high_s: t * 1.08,
  } as PredictionResult;
}

function loadGpx(file: string): { name: string; points: RoutePoint[] } | null {
  const p = path.join(GPX_DIR, file);
  if (!fs.existsSync(p)) {
    console.warn(`  (absent) ${p}`);
    return null;
  }
  const route = parseGpxText(fs.readFileSync(p, 'utf8'));
  return { name: route.name ?? file, points: route.points as RoutePoint[] };
}

function makeProject(name: string, itineraries: Itinerary[]): ItineraryProject {
  const base = createDefaultProject();
  return normalizeItineraryProject({
    ...base,
    name,
    itineraries,
    activeItineraryId: itineraries[0]?.id ?? base.activeItineraryId,
  });
}

// ── Mesures ──────────────────────────────────────────────────────────────
interface SizeReport {
  scenario: string;
  routeKm: number;
  storedPoints: number;
  pois: number;
  jsonBytes: number;
  gzB64Chars: number;
  ratio: number;
  passesClient: boolean;
  passesAppwrite: boolean;
  compressMs: number;
}

async function measure(scenario: string, project: ItineraryProject): Promise<SizeReport> {
  const jsonBytes = computeProjectSizeBytes(project);
  const t0 = performance.now();
  const compressed = await compressProjectPayload(project);
  const compressMs = performance.now() - t0;
  const routeKm = project.itineraries.reduce((s, it) => s + (it.metrics?.distanceKm ?? 0), 0);
  return {
    scenario,
    routeKm: Math.round(routeKm),
    storedPoints: project.itineraries.reduce((s, it) => s + (it.gpxRoute?.originalPoints?.length ?? 0), 0),
    pois: project.itineraries.reduce((s, it) => s + (it.poiFeatures?.length ?? 0), 0),
    jsonBytes,
    gzB64Chars: compressed.length,
    ratio: Math.round((jsonBytes / compressed.length) * 100) / 100,
    passesClient: !isProjectTooLarge(jsonBytes),
    passesAppwrite: compressed.length <= APPWRITE_DATA_MAX_CHARS,
    compressMs: Math.round(compressMs),
  };
}

function concatRoutes(routes: RoutePoint[][], targetKm: number): RoutePoint[] {
  // Enchaîne des tracés réels (décalés pour rester contigus) jusqu'à targetKm
  const out: RoutePoint[] = [];
  let distOffset = 0;
  let k = 0;
  while (true) {
    const r = routes[k % routes.length];
    const shiftLat = out.length ? out[out.length - 1].lat - r[0].lat : 0;
    const shiftLon = out.length ? out[out.length - 1].lon - r[0].lon : 0;
    for (const p of r) {
      const d = distOffset + (p.distanceM ?? 0);
      if (d / 1000 > targetKm) return out;
      out.push({ lat: p.lat + shiftLat, lon: p.lon + shiftLon, elevationM: p.elevationM, distanceM: d });
    }
    distOffset += r[r.length - 1].distanceM ?? 0;
    k++;
    if (k > 200) return out;
  }
}

function timeIt(fn: () => unknown, iters = 5): number {
  fn(); // warm-up
  const t: number[] = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return Math.round(t[Math.floor(t.length / 2)] * 10) / 10;
}
async function timeItAsync(fn: () => Promise<unknown>, iters = 5): Promise<number> {
  await fn();
  const t: number[] = [];
  for (let i = 0; i < iters; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return Math.round(t[Math.floor(t.length / 2)] * 10) / 10;
}

async function main() {
  // dashboardProjectCache.ts tire appwrite.ts (import.meta.env.*) et appCacheEpoch.ts
  // (__REDVIEW_BUILD_ID__, define Vite) : on bundle le VRAI module avec esbuild en
  // fournissant ces defines, puis on l'importe.
  const esbuild = await import('esbuild');
  const outFile = path.join(os.tmpdir(), `rv-audit-dashboardProjectCache-${process.pid}.mjs`);
  await esbuild.build({
    entryPoints: [path.resolve(import.meta.dirname, '../../src/pages/Dashboard/dashboardProjectCache.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'error',
    alias: { '@': path.resolve(import.meta.dirname, '../../src') },
    define: { 'import.meta.env': '{"DEV":false}', __REDVIEW_BUILD_ID__: '"audit"' },
  });
  const { buildLocalProjectCachePayload } = (await import(`file:///${outFile.replace(/\\/g, '/')}`)) as {
    buildLocalProjectCachePayload: (p: ItineraryProject) => { compacted: boolean; serialized: string } | null;
  };
  fs.rmSync(outFile, { force: true });
  console.log(`\n=== Audit A — taille de persistance projet (node ${process.version}) ===`);
  console.log(`Limite client MAX_PROJECT_SIZE_BYTES = ${MAX_PROJECT_SIZE_BYTES} octets JSON (limits.ts:3)`);
  console.log(`Limite Appwrite projects.data       = ${APPWRITE_DATA_MAX_CHARS} caractères (gz+base64)\n`);

  const tdf = loadGpx('Tour de France 2026.gpx');
  const gt20 = loadGpx('GT20.gpx');
  if (!tdf || !gt20) {
    console.error('GPX de référence introuvables : passer --gpx-dir');
    process.exit(3);
  }
  for (const r of [tdf, gt20]) {
    const km = (r.points[r.points.length - 1].distanceM ?? 0) / 1000;
    console.log(`GPX ${r.name}: ${r.points.length} pts, ${km.toFixed(0)} km, ${(r.points.length / km).toFixed(1)} pts/km`);
  }

  const reports: SizeReport[] = [];
  const scenarios: Array<[string, () => ItineraryProject]> = [
    ['TdF 2026 — trace seule', () =>
      makeProject('TdF', [buildItineraryFromPoints('TdF', tdf.points, 1, { pois: 0, prediction: false })])],
    ['GT20 — trace seule', () =>
      makeProject('GT20', [buildItineraryFromPoints('GT20', gt20.points, 1, { pois: 0, prediction: false })])],
    ['GT20 + 1000 POI + prédiction', () =>
      makeProject('GT20 full', [buildItineraryFromPoints('GT20', gt20.points, 1, { pois: 1000, prediction: true })])],
    ['TdF + GT20 (2 variantes) + 1000 POI chacune + prédictions', () =>
      makeProject('Ultra 2 var', [
        buildItineraryFromPoints('TdF', tdf.points, 1, { pois: 1000, prediction: true }),
        buildItineraryFromPoints('GT20', gt20.points, 2, { pois: 1000, prediction: true }),
      ])],
    ['GT20 ×3 variantes (dupliquées) + 1000 POI + prédiction', () =>
      makeProject('GT20 3 var', [1, 2, 3].map((i) =>
        buildItineraryFromPoints(`GT20 v${i}`, gt20.points, i, { pois: 1000, prediction: true })))],
  ];

  let heavy: ItineraryProject | null = null;
  for (const [name, build] of scenarios) {
    const project = build();
    const rep = await measure(name, project);
    reports.push(rep);
    if (name.startsWith('TdF + GT20')) heavy = project;
  }
  console.table(reports.map((r) => ({
    scenario: r.scenario,
    km: r.routeKm,
    'pts orig': r.storedPoints,
    POI: r.pois,
    'JSON (Mo)': (r.jsonBytes / 1e6).toFixed(2),
    'gz+b64 (Mo car.)': (r.gzB64Chars / 1e6).toFixed(2),
    ratio: r.ratio,
    'client OK': r.passesClient,
    'Appwrite OK': r.passesAppwrite,
    'compress ms': r.compressMs,
  })));

  // Contribution par champ (scénario lourd)
  if (heavy) {
    const it = heavy.itineraries[0];
    const parts: Record<string, unknown> = {
      'gpxRoute.originalPoints': it.gpxRoute?.originalPoints,
      'gpxRoute.points (simplifiés)': it.gpxRoute?.points,
      poiFeatures: it.poiFeatures,
      prediction: it.prediction,
      timeline: it.timeline,
    };
    console.log(`\nContribution par champ (itinéraire « ${it.name} ») :`);
    for (const [k, v] of Object.entries(parts)) {
      const s = JSON.stringify(v ?? null);
      const gz = (await compressProjectPayload(v as never)).length;
      console.log(`  ${k.padEnd(30)} JSON ${(s.length / 1e6).toFixed(2)} Mo  → gz+b64 ${(gz / 1e6).toFixed(2)} Mo`);
    }
  }

  // ── Longueur max qui tient dans Appwrite ──
  console.log('\nLongueur de parcours max (1 itinéraire, densité GPX native) qui tient dans 1 000 000 car. :');
  const pois_per_km = 1000 / ((gt20.points[gt20.points.length - 1].distanceM ?? 1) / 1000);
  const fitKm: Record<string, number> = {};
  for (const [label, withExtras] of [['trace seule', false], [`trace + POI (${pois_per_km.toFixed(2)}/km) + prédiction`, true]] as const) {
    let lo = 50, hi = 20_000;
    while (hi - lo > 25) {
      const mid = Math.round((lo + hi) / 2);
      const pts = concatRoutes([gt20.points, tdf.points], mid);
      const project = makeProject('bin', [buildItineraryFromPoints('bin', pts, 1, {
        pois: withExtras ? Math.round(pois_per_km * mid) : 0,
        prediction: withExtras,
      })]);
      const c = await compressProjectPayload(project);
      if (c.length <= APPWRITE_DATA_MAX_CHARS) lo = mid; else hi = mid;
    }
    fitKm[label] = lo;
    const pts = concatRoutes([gt20.points, tdf.points], lo);
    const json = computeProjectSizeBytes(makeProject('bin', [buildItineraryFromPoints('bin', pts, 1, {
      pois: withExtras ? Math.round(pois_per_km * lo) : 0, prediction: withExtras })]));
    console.log(`  ${label.padEnd(45)} ≈ ${lo} km (JSON ≈ ${(json / 1e6).toFixed(2)} Mo, très loin des 16 MiB client)`);
  }
  // Taille JSON à partir de laquelle la limite client se déclencherait (pour comparaison)
  {
    const pts = concatRoutes([gt20.points, tdf.points], 20_000);
    const project = makeProject('big', [buildItineraryFromPoints('big', pts, 1, { pois: 0, prediction: false })]);
    const js = computeProjectSizeBytes(project);
    const c = await compressProjectPayload(project);
    console.log(`  (repère) ${((pts[pts.length - 1].distanceM ?? 0) / 1000).toFixed(0)} km trace seule : JSON ${(js / 1e6).toFixed(1)} Mo, gz+b64 ${(c.length / 1e6).toFixed(1)} Mo → client ${isProjectTooLarge(js) ? 'REFUSE' : 'ACCEPTE'}`);
  }

  // ── Coût des sérialisations par autosave (scénario lourd) ──
  const timings: Record<string, number> = {};
  if (heavy) {
    const p = heavy;
    console.log('\nCoût CPU d\'UN autosave (scénario lourd, médiane de 5) — thread principal :');
    timings['flushSave JSON.stringify (useDashboardProjectSync.ts:72)'] = timeIt(() => JSON.stringify(p));
    timings['flushSave new Blob([serialized]).size (:92)'] = timeIt(() => new Blob([JSON.stringify(p)]).size) - timings['flushSave JSON.stringify (useDashboardProjectSync.ts:72)'];
    timings['writeProjectCache → buildLocalProjectCachePayload (dashboardProjectCache.ts:36-98)'] = timeIt(() => buildLocalProjectCachePayload(p));
    timings['idbSaveProjectCache structured clone (≈ structuredClone)'] = timeIt(() => structuredClone(p));
    timings['saveProject computeProjectSizeBytes localRow (projectRows.ts:229)'] = timeIt(() => computeProjectSizeBytes(p));
    timings['saveProject idbSaveProject structured clone (≈ structuredClone) (:237)'] = timeIt(() => structuredClone(p));
    timings['saveProject compressProjectPayload (:245)'] = await timeItAsync(() => compressProjectPayload(p));
    timings['saveProject computeProjectSizeBytes cloud (:249)'] = timeIt(() => computeProjectSizeBytes(p));
    const total = Object.values(timings).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(timings)) console.log(`  ${k.padEnd(88)} ${v.toFixed(1)} ms`);
    console.log(`  ${'TOTAL (hors réseau, hors account.get() fait par getCurrentUserId à chaque save)'.padEnd(88)} ${total.toFixed(1)} ms`);
    const cache = buildLocalProjectCachePayload(p);
    console.log(`  buildLocalProjectCachePayload → ${cache ? `compacted=${cache.compacted}, ${(cache.serialized.length / 1e6).toFixed(2)} Mo` : 'null (trop gros → cache localStorage désactivé pour ce projet)'}`);
    timings.total = total;

    // Lecture : décompression
    const c = await compressProjectPayload(p);
    timings['decompressProjectPayload (ouverture projet cloud)'] = await timeItAsync(() => decompressProjectPayload(c));
    console.log(`  decompressProjectPayload (ouverture cloud)                                              ${timings['decompressProjectPayload (ouverture projet cloud)'].toFixed(1)} ms`);
  }

  // ── Verdict ──
  const ultraFails = reports.filter((r) => r.scenario !== 'TdF 2026 — trace seule' && r.passesClient && !r.passesAppwrite);
  console.log('\n=== Verdict ===');
  if (ultraFails.length) {
    console.log(`ÉCHEC : ${ultraFails.length} projet(s) réaliste(s) passent la limite client (16 MiB) mais dépassent la limite Appwrite (1 000 000 car.) :`);
    for (const r of ultraFails) console.log(`  - ${r.scenario}: ${r.gzB64Chars} car.`);
    console.log('→ saveProject (projectRows.ts:243-255) avale l\'erreur Appwrite : la sauvegarde cloud échoue en silence.');
  } else {
    console.log('OK : aucun projet réaliste ne passe la limite client tout en dépassant Appwrite.');
  }

  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ reports, fitKm, timings }, null, 2));
  process.exit(ultraFails.length ? 1 : 0);
}


/** Projets de référence réutilisés par a-appwrite-live.ts. */
export function buildReferenceProjects(): { traceOnly: ItineraryProject; heavy: ItineraryProject; ultra: ItineraryProject } | null {
  const gt20 = loadGpx('GT20.gpx');
  if (!gt20) return null;
  return {
    traceOnly: makeProject('GT20 trace', [buildItineraryFromPoints('GT20', gt20.points, 1, { pois: 0, prediction: false })]),
    heavy: makeProject('GT20 full', [buildItineraryFromPoints('GT20', gt20.points, 1, { pois: 1000, prediction: true })]),
    // 3 variantes complètes : le plus gros projet réaliste mesuré (~4,5 M car. compressés).
    ultra: makeProject('GT20 x3', [1, 2, 3].map((n) => buildItineraryFromPoints(`GT20 v${n}`, gt20.points, n, { pois: 1000, prediction: true }))),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(4);
  });
}
