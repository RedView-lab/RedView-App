/**
 * Tri automatique des POI — test de bout en bout sur une vraie trace.
 *
 *   1. parse la trace GPX,
 *   2. récupère les POI du corridor sur le serveur POI (`POI_UPSTREAM` du .env),
 *   3. calcule la prédiction avec le VRAI moteur WASM (config issue du rythme),
 *   4. lance `computePoiAutoSort` exactement comme l'app,
 *   5. imprime la feuille de route retenue et vérifie les règles,
 *   6. applique le tri comme l'app depuis le 2026-10-02 : un FILTRE de la
 *      feuille de route (`poiAutoSort.picks`), jamais des favoris posés dans
 *      la timeline ; une relance garde les favoris manuels.
 *
 * POI et prédiction sont mis en cache (dossier temp) : `--refresh` pour refaire.
 *
 * Usage :
 *   npx tsx script-test-bench/regression/poi-autosort.ts <trace.gpx>
 *     [--level=intermediaire] [--start=07:30] [--date=2026-10-03]
 *     [--x=40] [--x-hotel=40] [--pause] [--refresh] [--quiet]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PredictionResult } from '../../src/features/fitPredictor/types.ts';
import { GT20_GPX } from '../core/data-paths.ts';
import { CYCLING_ENGINE_VERSION } from '../../src/features/fitPredictor/engine/version.ts';
import { DEFAULT_AUTO_SORT_RULES } from '../../src/features/poi/lib/autoSort/index.ts';
import type { PoiCategory as FeaturePoiCategory, PoiFeature } from '../../src/features/poi/types.ts';
import { createDefaultItinerary } from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import {
  buildPredictionConfigFromRhythm,
  buildRouteGpxFile,
} from '../../src/features/itineraryPanel/lib/schedule/container-prediction.ts';
import {
  clearPoiAutoSortFavorites,
  computePoiAutoSort,
  getPoiAutoSortPicks,
  keepsTimelineItemWithPoiAutoSort,
  toPoiAutoSortPickRefs,
  type PoiAutoSortRun,
} from '../../src/features/itineraryPanel/lib/schedule/poiAutoSort.ts';
import { FEATURE_TO_PANEL_POI, poiFeaturesToTimelineItems } from '../../src/features/itineraryPanel/lib/schedule/poi-to-timeline.ts';
import type { Itinerary, PoiCategory as PanelPoiCategory } from '../../src/features/itineraryPanel/types/index.ts';

// ── Arguments ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => args.some((a) => a === `--${name}`);
const option = (name: string, fallback: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const gpxPath = args.find((a) => !a.startsWith('--')) ?? GT20_GPX;
const level = option('level', 'intermediaire');
const startTime = option('start', '07:30');
const startDate = option('date', '');
const xDefault = Number(option('x', '40'));
const xHotel = Number(option('x-hotel', String(xDefault)));
const refresh = flag('refresh');
const quiet = flag('quiet');

const CACHE_DIR = path.join(os.tmpdir(), 'redview-poi-autosort');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function readEnv(): Record<string, string> {
  const file = path.resolve('.env');
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

// ── 1. Trace ──────────────────────────────────────────────────────────
const gpxText = fs.readFileSync(gpxPath, 'utf8');
const points: NonNullable<Itinerary['gpxRoute']>['points'] = [];
for (const m of gpxText.matchAll(/<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g)) {
  const ele = /<ele>([-\d.]+)<\/ele>/.exec(m[3]!);
  points.push({ lat: Number(m[1]), lon: Number(m[2]), elevationM: ele ? Number(ele[1]) : null });
}
if (points.length < 2) throw new Error(`Aucun point dans ${gpxPath}`);
const traceHash = crypto.createHash('sha1').update(gpxText).digest('hex').slice(0, 12);

const itinerary = createDefaultItinerary(1);
itinerary.name = path.basename(gpxPath, '.gpx');
itinerary.gpxRoute = { name: itinerary.name, points };
itinerary.rhythm = {
  ...itinerary.rhythm,
  rhythmProfile: 'preset',
  practiceLevel: level,
  startTime,
  startDate: startDate || null,
  pauseAtFavoritePois: flag('pause'),
};
for (const key of Object.keys(itinerary.poi) as PanelPoiCategory[]) {
  itinerary.poi[key] = { ...itinerary.poi[key], distanceM: key === 'hotels' ? xHotel : xDefault };
}

// ── 2. POI du corridor ────────────────────────────────────────────────
async function loadPois(): Promise<PoiFeature[]> {
  const enabledPanels = new Set(
    (Object.keys(itinerary.poi) as PanelPoiCategory[]).filter((key) => itinerary.poi[key].enabled),
  );
  const categories = (Object.keys(FEATURE_TO_PANEL_POI) as FeaturePoiCategory[]).filter((cat) =>
    enabledPanels.has(FEATURE_TO_PANEL_POI[cat]!),
  );
  const radiusM = Math.max(xDefault, xHotel);
  const cacheFile = path.join(CACHE_DIR, `pois-${traceHash}-${radiusM}.json`);
  if (!refresh && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const upstream = (readEnv().POI_UPSTREAM ?? process.env.POI_UPSTREAM ?? 'http://localhost:17778').replace(/\/$/, '');
  // Même densité d'échantillonnage que usePoi (≈ rayon × 1,4, ≥ 10 m).
  const spacing = Math.max(10, radiusM * 1.4);
  const samples: Array<[number, number]> = [[points[0]!.lat, points[0]!.lon]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 111_320;
    const dy = (b.lat - a.lat) * 110_540;
    acc += Math.hypot(dx, dy);
    if (acc >= spacing) {
      samples.push([b.lat, b.lon]);
      acc = 0;
    }
  }
  samples.push([points[points.length - 1]!.lat, points[points.length - 1]!.lon]);

  const res = await fetch(`${upstream}/corridor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: samples, radiusM, categories }),
  });
  if (!res.ok) throw new Error(`POI corridor HTTP ${res.status}`);
  const features = ((await res.json()) as { features: PoiFeature[] }).features;
  fs.writeFileSync(cacheFile, JSON.stringify(features));
  return features;
}

// ── 3. Prédiction WASM ────────────────────────────────────────────────
async function loadPrediction(): Promise<PredictionResult> {
  const config = buildPredictionConfigFromRhythm(itinerary.rhythm, points);
  // La version du moteur dans la clé : un moteur mis à jour ne relit pas une prédiction périmée.
  const key = crypto.createHash('sha1').update(`${traceHash}:${CYCLING_ENGINE_VERSION}:${JSON.stringify(config)}`).digest('hex').slice(0, 12);
  const cacheFile = path.join(CACHE_DIR, `prediction-${key}.json`);
  if (!refresh && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const pkg = path.resolve('src/features/fitPredictor/engine/pkg');
  const glue = await import(new URL(`file:///${path.join(pkg, 'redviewalgo.js').replace(/\\/g, '/')}`).href);
  glue.initSync({ module: fs.readFileSync(path.join(pkg, 'redviewalgo_bg.wasm')) });
  const gpxBytes = new Uint8Array(await buildRouteGpxFile(itinerary).arrayBuffer());
  const log = console.log;
  console.log = () => {};
  try {
    const result = glue.predict([], gpxBytes, config, null) as PredictionResult;
    fs.writeFileSync(cacheFile, JSON.stringify(result));
    return result;
  } finally {
    console.log = log;
  }
}

// ── 4. Tri + rapport ──────────────────────────────────────────────────
const pad = (value: unknown, width: number) => String(value).slice(0, width).padEnd(width);
const fmtClock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
const fmtH = (seconds: number) => `${Math.floor(seconds / 3600)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`;

async function main() {
  const [features, prediction] = await Promise.all([loadPois(), loadPrediction()]);
  itinerary.poiFeatures = features;
  itinerary.prediction = prediction;

  const t0 = performance.now();
  const run = computePoiAutoSort(itinerary, prediction, new Date());
  const elapsedMs = performance.now() - t0;
  if (!run) throw new Error('computePoiAutoSort a renvoyé null');
  const { result } = run;
  const rules = DEFAULT_AUTO_SORT_RULES;

  const totalKm = (prediction.total_distance_m / 1000).toFixed(0);
  console.log(`\n${itinerary.name} — ${totalKm} km, ${level}, départ ${startTime}${startDate ? ` le ${startDate}` : ''}`);
  console.log(`Prédiction : ${fmtH(prediction.total_time_s)} de roulage (${prediction.avg_speed_kmh.toFixed(1)} km/h moy.)`);
  console.log(`POI corridor : ${features.length} · candidats : ${result.stats.candidates} · retenus : ${result.picks.length} · ${elapsedMs.toFixed(0)} ms`);
  console.log(`Raisons : ${Object.entries(result.stats.byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`Écart max eau ${result.stats.maxWaterGapH.toFixed(2)}h · ravito ${result.stats.maxResupplyGapH.toFixed(2)}h · points d'eau en descente écartés ${result.stats.descentsAvoided} · hôtels/nuit [${result.stats.hotelsPerNight.join(', ')}]`);
  for (const w of result.warnings) {
    console.log(`  ⚠ ${w.kind} km ${w.fromKm} → ${w.toKm} (${w.hours.toFixed(1)}h)`);
  }

  if (!quiet) {
    console.log(`\n${pad('Heure', 7)}${pad('+T', 7)}${pad('km', 7)}${pad('raison', 9)}${pad('catégorie', 16)}${pad('ouvert', 8)}${pad('lat.', 6)}${pad('côté', 6)}${pad('pente', 7)}nom`);
    for (const p of result.picks) {
      console.log(
        pad(fmtClock(p.arrival), 7)
        + pad(fmtH(p.scheduledSeconds), 7)
        + pad((p.progressM / 1000).toFixed(1), 7)
        + pad(p.reason, 9)
        + pad(p.feature.category, 16)
        + pad(p.openStatus === 'unknown' ? (p.likelyOpen ? 'prob.' : 'improb.') : p.openStatus, 8)
        + pad(Math.round(p.lateralM), 6)
        + pad(p.side, 6)
        + pad(`${p.gradePct.toFixed(1)}%`, 7)
        + (p.feature.name ?? '—')
        + (p.fallback ? '  (repli)' : ''),
      );
    }
  }

  // ── Vérifications ──
  const failures: string[] = [];
  const warnedWater = result.warnings.filter((w) => w.kind === 'waterGap');
  const warnedFood = result.warnings.filter((w) => w.kind === 'resupplyGap');
  const tolH = 0.01;
  if (result.stats.maxWaterGapH > rules.water.maxGapH + tolH && warnedWater.length === 0) {
    failures.push(`écart d'eau ${result.stats.maxWaterGapH.toFixed(2)}h > ${rules.water.maxGapH}h sans avertissement`);
  }
  if (result.stats.maxResupplyGapH > rules.resupply.maxGapH + tolH && warnedFood.length === 0) {
    failures.push(`écart ravito ${result.stats.maxResupplyGapH.toFixed(2)}h > ${rules.resupply.maxGapH}h sans avertissement`);
  }
  for (const p of result.picks.filter((pick) => pick.reason === 'hotel')) {
    const minute = p.arrival.getHours() * 60 + p.arrival.getMinutes();
    if (minute < 18 * 60 && minute >= 6 * 60) failures.push(`hôtel hors 18h–6h : ${p.feature.name} à ${fmtClock(p.arrival)}`);
  }
  const maxHotelsPerNight = rules.hotel.slots.reduce((sum, slot) => sum + slot.max, 0);
  if (result.stats.hotelsPerNight.some((n) => n > maxHotelsPerNight)) failures.push(`plus de ${maxHotelsPerNight} hôtels sur une nuit`);
  // Soirée : s'il y a des hôtels entre 18h et 22h, on doit en proposer.
  const eveningHotels = result.picks.filter((p) => p.reason === 'hotel' && p.arrival.getHours() >= 18 && p.arrival.getHours() < 22);
  if (eveningHotels.length === 0) failures.push('aucun hôtel retenu entre 18h et 22h');
  for (const p of result.picks) {
    if (p.kind === 'water' && p.gradePct <= rules.water.descentGradePct && !p.fallback) {
      failures.push(`point d'eau en descente non signalé : ${p.feature.name ?? p.feature.id}`);
    }
    if ((p.kind === 'shop' || p.kind === 'meal' || p.kind === 'night') && p.openStatus === 'closed' && p.reason !== 'gap6h') {
      failures.push(`ravito fermé au passage : ${p.feature.name} à ${fmtClock(p.arrival)}`);
    }
  }
  const ids = result.picks.map((p) => p.feature.id);
  if (new Set(ids).size !== ids.length) failures.push('POI retenu deux fois');

  // ── Application comme l'app : un filtre de la feuille de route ──
  const draft = structuredClone(itinerary);
  draft.timeline = [...draft.timeline, ...poiFeaturesToTimelineItems(features, points)];
  const apply = (it: Itinerary, sortRun: PoiAutoSortRun) => {
    clearPoiAutoSortFavorites(it);
    it.poiAutoSortEnabled = true;
    it.poiAutoSort = {
      signature: 'bench',
      summary: { total: sortRun.result.picks.length, byReason: sortRun.result.stats.byReason, warnings: sortRun.result.warnings, usedPrediction: sortRun.usedPrediction },
      picks: toPoiAutoSortPickRefs(sortRun),
      ranAt: new Date().toISOString(),
    };
  };
  const shownPoiIds = (it: Itinerary) => {
    const picks = getPoiAutoSortPicks(it);
    if (!picks) return null;
    return new Set(it.timeline.filter((row) => row.kind === 'poi' && keepsTimelineItemWithPoiAutoSort(row, picks)).map((row) => row.osmId));
  };
  apply(draft, run);
  const timelineIds = new Set(draft.timeline.filter((row) => row.kind === 'poi').map((row) => row.osmId));
  const shown = shownPoiIds(draft);
  if (!shown) failures.push('application : filtre absent');
  else {
    const missing = ids.filter((id) => timelineIds.has(id) && !shown.has(id));
    if (missing.length > 0) failures.push(`application : ${missing.length} POI retenus masqués`);
    if (shown.size > new Set(ids).size) failures.push(`application : ${shown.size} POI affichés pour ${ids.length} retenus`);
  }
  if (draft.timeline.some((row) => row.favoriteSource === 'auto' || (row.kind === 'poi' && row.favorite))) {
    failures.push('application : le tri a posé des favoris dans la timeline');
  }

  // ── Relance : un favori manuel n'est plus proposé et reste affiché ──
  const keptRow = draft.timeline.find((row) => row.kind === 'poi' && row.osmId === ids[0]);
  if (keptRow) {
    keptRow.favorite = true;
    keptRow.favoriteSource = 'manual';
    draft.rhythm = { ...draft.rhythm, startTime: '09:15' };
    const rerun = computePoiAutoSort(draft, prediction, new Date());
    if (!rerun) {
      failures.push('relance : aucun résultat');
    } else {
      if (rerun.result.picks.some((p) => p.feature.id === keptRow.osmId)) failures.push('relance : favori manuel re-proposé');
      apply(draft, rerun);
      if (!keptRow.favorite || keptRow.favoriteSource !== 'manual') failures.push('relance : favori manuel perdu');
      if (!shownPoiIds(draft)?.has(keptRow.osmId)) failures.push('relance : favori manuel masqué par le filtre');
      console.log(`Relance (départ 09:15, 1 favori manuel) : ${rerun.result.picks.length} POI retenus`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n✗ ${failures.length} échec(s) :`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n✓ règles respectées');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
