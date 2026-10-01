/**
 * bench:pace — banc de précision du moteur de temps vélo v2.
 *
 *   npx tsx script-test-bench/pace-accuracy/run.ts [--quick] [--only=R1,S3] [--pkg=<dir>]
 *
 * Scénarios réels (R1–R11) sur les 6 .fit Cham→Paris et scénarios
 * synthétiques (S1–S24). Chaque scénario est un critère physique dur (H) ou
 * une cible produit (P). Code de sortie ≠ 0 si un critère H échoue.
 * Prérequis réseau (une fois) : `npm run bench:pace:prep`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_PKG, loadPkg, predictLegacy, predictV2, silenceConsole, trackToRoutePoints, trackToV2Route, type V2Route } from './lib/engine';
import { compare, pct } from './lib/metrics';
import { enrichRide } from './lib/osm-enrich';
import { extractRide, formatHms, loadRides, realTimeAt, RIDES, type Ride } from './lib/rides';
import { hairpins, reversed, routeFromXY, straight, subsample, withNoise, type XY } from './lib/synthetic';
import { headwindAlongRide } from './lib/wind';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const QUICK = process.argv.includes('--quick');
const ONLY = arg('only')?.split(',');
const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '.out');

interface Outcome { id: string; kind: 'H' | 'P' | 'I'; label: string; pass: boolean; detail: string }
const outcomes: Outcome[] = [];

let glue: any;
let rides: Ride[];
const JO = { preset: { level: 'intermediaire', gender: 'female' } };
const PRIOR = { custom: { gender: 'female' } };
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
const maxAbs = (v: number[]) => Math.max(...v.map(Math.abs));

function predict(route: V2Route, config: Record<string, unknown>) {
  return predictV2(glue, route, { geometry: 'planned', ...config });
}

const calibCache = new Map<string, any>();
function calibrate(train: Ride[], extra: Record<string, unknown> = {}) {
  const key = train.map((r) => r.id).join('+') + JSON.stringify(extra);
  if (!calibCache.has(key)) {
    calibCache.set(key, silenceConsole(() => glue.calibrate_cycling(train.map((r) => r.bytes), { rider: PRIOR, ...extra }, () => {})));
  }
  return calibCache.get(key);
}

// ── Physique de référence (indépendante du moteur) ──────────────────────────
const G = 9.80665;
const rho = (h: number) => (101325 * Math.max(0.1, 1 - 2.25577e-5 * h) ** 5.25588) / (287.05 * (15 - 0.0065 * h + 273.15));
const altFactor = (h: number) => { const k = Math.min(5, Math.max(0, h / 1000)); return Math.min(1, Math.max(0.5, 1 + 0.00178 * k ** 3 - 0.0143 * k ** 2 - 0.00407 * k)); };
function steady(pWheel: number, g: number, m: number, crr: number, cda: number, r: number): number {
  const th = Math.atan(g);
  const res = (v: number) => (m * G * Math.sin(th) + crr * m * G * Math.cos(th) + 0.5 * r * cda * v * v) * v;
  let lo = 1e-3, hi = 40;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (res(mid) < pWheel) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function powerAt(model: any, g: number): number {
  if (g >= 0) return model.p_flat_w * (1 + (model.climb_ratio - 1) * (1 - Math.exp(-g / model.climb_sat_pct)));
  return model.p_flat_w * Math.max(0, 1 + g / model.free_pct);
}

function record(id: string, kind: Outcome['kind'], label: string, pass: boolean, detail: string) {
  outcomes.push({ id, kind, label, pass, detail });
  const tag = kind === 'I' ? 'INFO' : pass ? 'OK  ' : kind === 'H' ? 'ÉCHEC' : 'hors cible';
  console.log(`${tag.padEnd(10)} ${id.padEnd(4)} ${label}\n           ${detail.replace(/\n/g, '\n           ')}`);
}

// ── Scénarios réels ─────────────────────────────────────────────────────────
function r1r2r3() {
  const loo: number[] = [];
  const inS: number[] = [];
  const full = calibrate(rides);
  for (const ride of rides) {
    inS.push(compare(ride.track, predict(trackToV2Route(ride.track), { rider: { model: full.model }, geometry: 'gps' })).errPct);
    const m = calibrate(rides.filter((r) => r.id !== ride.id)).model;
    loo.push(compare(ride.track, predict(trackToV2Route(ride.track), { rider: { model: m }, geometry: 'gps' })).errPct);
  }
  record('R1', 'P', 'LOO : chaque jour prédit par un modèle calibré sur les 5 autres', median(loo.map(Math.abs)) <= 5 && maxAbs(loo) <= 8,
    `${rides.map((r, i) => `${r.id} ${pct(loo[i]!)}`).join('  ')}\n|err| médiane ${median(loo.map(Math.abs)).toFixed(1)} % (≤ 5), max ${maxAbs(loo).toFixed(1)} % (≤ 8)`);
  const alps = rides.filter((r) => r.id === 'D1' || r.id === 'D2');
  const plains = rides.filter((r) => !alps.includes(r));
  const fromAlps = calibrate(alps).model;
  const fromPlains = calibrate(plains).model;
  const cross = [
    ...plains.map((r) => compare(r.track, predict(trackToV2Route(r.track), { rider: { model: fromAlps }, geometry: 'gps' })).errPct),
    ...alps.map((r) => compare(r.track, predict(trackToV2Route(r.track), { rider: { model: fromPlains }, geometry: 'gps' })).errPct),
  ];
  record('R2', 'P', 'Croisé : jours alpins → plaine et plaine → jours alpins', maxAbs(cross) <= 7,
    `${[...plains, ...alps].map((r, i) => `${r.id} ${pct(cross[i]!)}`).join('  ')}  max ${maxAbs(cross).toFixed(1)} % (≤ 7)`);
  record('R3', 'P', 'In-sample : calibré sur les 6 jours', median(inS.map(Math.abs)) <= 5,
    `${rides.map((r, i) => `${r.id} ${pct(inS[i]!)}`).join('  ')}  médiane ${median(inS.map(Math.abs)).toFixed(1)} %  (rapport moteur : LOO ${full.report.loo_median_abs_pct} %, précision ±${full.report.expected_accuracy_pct} %)`);
  const realTotal = rides.reduce((s, r) => s + r.movingTimeS, 0);
  const predTotal = rides.reduce((s, r, i) => s + r.movingTimeS * (1 + loo[i]! / 100), 0);
  const trip = (predTotal / realTotal - 1) * 100;
  record('R5', 'P', 'Voyage complet 724 km (somme des prédictions LOO)', Math.abs(trip) <= 3,
    `${formatHms(predTotal)} prédit pour ${formatHms(realTotal)} réel → ${pct(trip)} (≤ 3 %)`);
}

function r4() {
  const realTotal = rides.reduce((s, r) => s + r.movingTimeS, 0);
  const trip = (level: string, gender: string) => {
    const t = rides.reduce((s, r) => s + compare(r.track, predict(trackToV2Route(r.track), { rider: { preset: { level, gender } }, geometry: 'gps' })).predS, 0);
    return (t / realTotal - 1) * 100;
  };
  const jo = trip('intermediaire', 'female');
  const def = trip('intermediaire', 'unspecified');
  const deb = trip('debutant', 'female');
  const debDef = trip('debutant', 'unspecified');
  record('R4', 'P', 'Préréglages ancrés sur Jo', Math.abs(jo) <= 5 && def <= 0 && def >= -5 && deb >= 10 && debDef > 0,
    `intermédiaire ♀ ${pct(jo)} (±5)  intermédiaire défaut ${pct(def)} (−5..0)  débutant ♀ ${pct(deb)} (≥ +10)  débutant défaut ${pct(debDef)} (> 0 : plus lent qu'elle)`);
}

function r6() {
  const lines: string[] = [];
  let worst = 0;
  for (const id of ['D1', 'D2'] as const) {
    const ride = rides.find((r) => r.id === id)!;
    const m = calibrate(rides.filter((r) => r.id !== id)).model;
    const pred = predict(trackToV2Route(ride.track), { rider: { model: m }, geometry: 'gps' });
    const total = ride.track[ride.track.length - 1]!.d;
    // Sommet principal puis point bas suivant : la grande descente ; point bas précédent : la montée.
    const tr = ride.track;
    let top = 0;
    for (let i = 0; i < tr.length; i++) if (tr[i]!.ele > tr[top]!.ele) top = i;
    let lowAfter = top; for (let i = top; i < tr.length; i++) if (tr[i]!.ele < tr[lowAfter]!.ele) lowAfter = i;
    let lowBefore = top; for (let i = top; i >= 0; i--) if (tr[i]!.ele < tr[lowBefore]!.ele) lowBefore = i;
    const section = (label: string, a: number, b: number) => {
      const da = tr[a]!.d, db = tr[b]!.d;
      const real = realTimeAt(tr, db) - realTimeAt(tr, da);
      const pts = pred.points;
      const at = (d: number) => {
        const f = d / total * pred.total_distance_m;
        let j = 0; while (j + 1 < pts.length && pts[j + 1].distance_m <= f) j++;
        const p0 = pts[j], p1 = pts[Math.min(j + 1, pts.length - 1)];
        const span = p1.distance_m - p0.distance_m;
        return span > 0 ? p0.elapsed_time_s + (p1.elapsed_time_s - p0.elapsed_time_s) * (f - p0.distance_m) / span : p0.elapsed_time_s;
      };
      const p = at(db) - at(da);
      const e = (p / real - 1) * 100;
      worst = Math.max(worst, Math.abs(e));
      lines.push(`${id} ${label.padEnd(9)} ${((db - da) / 1000).toFixed(1).padStart(5)} km ${Math.round(tr[b]!.ele - tr[a]!.ele).toString().padStart(6)} m  réel ${formatHms(real)}  prédit ${formatHms(p)}  ${pct(e)}`);
    };
    section('montée', lowBefore, top);
    section('descente', top, lowAfter);
  }
  record('R6', 'P', 'Cols nommés (Forclaz, Faucille) : montée et descente principales, LOO', worst <= 15, lines.join('\n'));
}

async function r7r8() {
  const osm = await Promise.all(rides.map((r) => enrichRide(r)));
  const errB: number[] = [];
  const lines: string[] = [];
  for (const [i, ride] of rides.entries()) {
    const m = calibrate(rides.filter((r) => r.id !== ride.id)).model;
    const p = osm[i]!.planned;
    const route: V2Route = {
      lat: Float64Array.from(p.lat), lon: Float64Array.from(p.lon), ele: Float64Array.from(p.ele), dist: Float64Array.from(p.dist),
      surface: Uint8Array.from(p.surface), way: Uint8Array.from(p.way), wind: new Float64Array(0),
    };
    const pred = predict(route, { rider: { model: m }, geometry: 'planned' });
    // Comparaison à vitesse moyenne égale : la route BRouter diffère de quelques % en longueur.
    const e = ((pred.total_time_s / pred.total_distance_m) / (ride.movingTimeS / ride.distanceM) - 1) * 100;
    errB.push(e);
    lines.push(`${ride.id} ${(pred.total_distance_m / 1000).toFixed(1)} km (FIT ${(ride.distanceM / 1000).toFixed(1)})  D+ ${Math.round(pred.elevation_gain_m)}  ${pct(e)}`);
  }
  record('R7', 'P', 'Mode B : route BRouter (altitude MNT, tags), modèle LOO', median(errB.map(Math.abs)) <= 6,
    `${lines.join('\n')}\n|err| médiane ${median(errB.map(Math.abs)).toFixed(1)} % (≤ 6), max ${maxAbs(errB).toFixed(1)} %`);
  // R8 : tags OSM sur la trace FIT (revêtement, type de voie).
  const tracks = (withTags: boolean) => rides.map((r, i) => ({
    lat: r.track.map((p) => p.lat), lon: r.track.map((p) => p.lon), ele: r.track.map((p) => p.ele),
    dist: r.track.map((p) => p.d), t: r.track.map((p) => p.t),
    surface: withTags ? osm[i]!.trackSurface : [], way: withTags ? osm[i]!.trackWay : [],
  }));
  const a = silenceConsole(() => glue.calibrate_cycling_tracks(tracks(false), { rider: PRIOR })).report;
  const b = silenceConsole(() => glue.calibrate_cycling_tracks(tracks(true), { rider: PRIOR })).report;
  record('R8', 'I', 'Apport des tags OSM sur ce voyage (revêtu à 99 %)', true,
    `sans tags : LOO médiane ${a.loo_median_abs_pct} %, max ${a.loo_max_abs_pct} %  |  avec tags : ${b.loo_median_abs_pct} %, ${b.loo_max_abs_pct} %`);
}

async function r9() {
  const errs = async (wind: boolean) => {
    const out: number[] = [];
    for (const r of rides) {
      const w = wind ? await headwindAlongRide(r) : undefined;
      out.push(compare(r.track, predict(trackToV2Route(r.track, { wind: w }), { rider: JO, geometry: 'gps' })).errPct);
    }
    return out;
  };
  const std = (v: number[]) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length); };
  const a = await errs(false);
  const b = await errs(true);
  record('R9', 'I', 'Vent historique (ERA5, ×0,6 à hauteur de cycliste) : part de l\'écart journalier', true,
    `sans vent : ${a.map((v) => pct(v, 0)).join(' ')}  écart-type ${std(a).toFixed(1)} %\navec vent : ${b.map((v) => pct(v, 0)).join(' ')}  écart-type ${std(b).toFixed(1)} %  → ${std(b) < std(a) ? 'le vent explique une partie de l\'écart' : 'le vent n\'explique pas l\'écart journalier'}`);
}

function r10() {
  let worst = 0;
  const lines = RIDES.map((meta) => {
    const t = [0.3, 0.6, 1.0].map((v) => extractRide(meta, { minMovingSpeedMs: v }).movingTimeS);
    const spread = (Math.max(...t) - Math.min(...t)) / t[1]! * 100;
    worst = Math.max(worst, spread);
    return `${meta.id} ${t.map(formatHms).join(' / ')} (${spread.toFixed(1)} %)`;
  });
  record('R10', 'H', 'Définition du moving time (seuils 0,3 / 0,6 / 1,0 m/s)', worst <= 2, `${lines.join('  ')}\nécart max ${worst.toFixed(1)} % (≤ 2)`);
}

async function r11() {
  const old = await loadPkg(BASELINE_PKG);
  const errs: number[] = [];
  for (const ride of rides) {
    const others = rides.filter((r) => r.id !== ride.id).map((r) => r.bytes);
    const pred = await predictLegacy(old, trackToRoutePoints(ride.track), { kind: 'custom', fits: others });
    errs.push(compare(ride.track, pred).errPct);
  }
  record('R11', 'I', 'Ancien moteur (référence) en LOO', true,
    `${rides.map((r, i) => `${r.id} ${pct(errs[i]!)}`).join('  ')}  biais ${pct(errs.reduce((s, v) => s + v, 0) / errs.length)}`);
}

// ── Scénarios synthétiques ──────────────────────────────────────────────────
function s1() {
  const model = { ...silenceConsole(() => predict(straight(1000, () => 0), { rider: JO })).model, warmup_amp: 0 };
  const L = 13_800, grade = 0.081, base = 720;
  const route = straight(L, (d) => base + grade * d);
  const t = predict(route, { rider: { model } }).total_time_s;
  let tRef = 0;
  for (let d = 0; d < L; d += 10) {
    const h = base + grade * (d + 5);
    const v = steady(model.drivetrain_eff * powerAt(model, grade * 100) * altFactor(h), grade, model.mass_kg, model.crr, model.cda, rho(h));
    tRef += 10 / v;
  }
  const e = (t / tRef - 1) * 100;
  record('S1', 'H', 'Alpe d\'Huez (13,8 km à 8,1 %) : moteur vs régime établi indépendant', Math.abs(e) <= 2,
    `moteur ${formatHms(t)}  référence ${formatHms(tRef)}  ${pct(e)} (≤ 2 %)`);
  const bands: Record<string, [number, number]> = { debutant: [450, 650], intermediaire: [650, 850], avance: [850, 1100], expert: [1050, 1350] };
  const lines: string[] = [];
  let ok = true;
  for (const [level, [lo, hi]] of Object.entries(bands)) {
    const tt = predict(route, { rider: { preset: { level, gender: 'unspecified' } } }).total_time_s;
    const vam = (L * grade) / (tt / 3600);
    ok &&= vam >= lo && vam <= hi;
    lines.push(`${level} ${formatHms(tt)} ${Math.round(vam)} m/h (${lo}-${hi})`);
  }
  record('S1b', 'P', 'VAM par niveau sur l\'Alpe d\'Huez (genre par défaut)', ok, lines.join('  '));
}

function s2() {
  const bands: Record<string, [number, number]> = { debutant: [19, 24], intermediaire: [22, 27], avance: [26, 31], expert: [29, 36] };
  const route = straight(100_000, () => 100, { step: 50 });
  let ok = true;
  const lines = Object.entries(bands).map(([level, [lo, hi]]) => {
    const v = 100 / (predict(route, { rider: { preset: { level, gender: 'unspecified' } } }).total_time_s / 3600);
    ok &&= v >= lo && v <= hi;
    return `${level} ${v.toFixed(1)} km/h (${lo}-${hi})`;
  });
  record('S2', 'P', '100 km de plat : vitesse par niveau', ok, lines.join('  '));
}

function s3() {
  const route = hairpins(10, 8, 150, -0.07);
  const res = predict(route, { rider: JO, model_params: { output_min_spacing_m: 10 }, output: { diagnostics: true } });
  const vmin = Math.min(...res.points.slice(5, -5).map((p: any) => p.predicted_speed_kmh));
  const expected = Math.sqrt(res.model.a_lat_ms2 * 8) * 3.6;
  const perHairpin = res.time_breakdown.corner_loss_s / 10;
  record('S3', 'H', '10 épingles R = 8 m à −7 % : vitesse à l\'apex et coût par épingle',
    Math.abs(vmin / expected - 1) <= 0.2 && perHairpin >= 3 && perHairpin <= 20,
    `apex ${vmin.toFixed(1)} km/h (attendu √(a_lat·R) = ${expected.toFixed(1)}), coût ${perHairpin.toFixed(1)} s / épingle (3-20 s)`);
}

function s4() {
  const prof = (d: number) => 500 + 60 * Math.sin(d / 1500) + 25 * Math.sin(d / 400);
  const fine = straight(30_000, prof, { step: 5 });
  const t5 = predict(fine, { rider: JO }).total_time_s;
  const variants = [['10 m', subsample(fine, 2)], ['30 m', subsample(fine, 6)], ['100 m', subsample(fine, 20)]] as const;
  const errs = variants.map(([, r]) => (predict(r, { rider: JO }).total_time_s / t5 - 1) * 100);
  record('S4', 'H', 'Résolution des points source (5 / 10 / 30 / 100 m)', maxAbs(errs.slice(0, 2)) <= 1 && Math.abs(errs[2]!) <= 2,
    `${variants.map(([l], i) => `${l} ${pct(errs[i]!, 2)}`).join('  ')} (≤ 1 % à 30 m, ≤ 2 % à 100 m)`);
}

function s5() {
  const clean = straight(20_000, () => 200, { step: 5 });
  const t0 = predict(clean, { rider: JO, geometry: 'gps' }).total_time_s;
  const noisy = withNoise(clean, 1.0, 0, 11);
  const t1 = predict(noisy, { rider: JO, geometry: 'gps' }).total_time_s;
  const e = (t1 / t0 - 1) * 100;
  record('S5', 'H', 'Bruit GPS réaliste sur 20 km de ligne droite : pas de faux virages', Math.abs(e) <= 0.5, `${pct(e, 2)} (≤ 0,5 %)`);
}

function s6() {
  const prof = (d: number) => 300 + 40 * Math.sin(d / 2000);
  const clean = straight(30_000, prof, { step: 25 });
  const t0 = predict(clean, { rider: JO }).total_time_s;
  const t1 = predict(withNoise(clean, 0, 1.5, 3), { rider: JO }).total_time_s;
  const e = (t1 / t0 - 1) * 100;
  record('S6', 'H', 'Bruit d\'altitude MNT ±1,5 m', Math.abs(e) <= 1, `${pct(e, 2)} (≤ 1 %)`);
}

function s7() {
  const route = straight(1000, (d) => (d < 300 ? 0 : d < 700 ? 0.2 * (d - 300) : 80), { surface: 3 });
  const res = predict(route, { rider: JO, model_params: { output_min_spacing_m: 10 } });
  const wall = res.points.filter((p: any) => p.distance_m > 380 && p.distance_m < 650);
  const v = wall.reduce((s: number, p: any) => s + p.predicted_speed_kmh, 0) / wall.length;
  record('S7', 'P', 'Mur de gravier à 20 % sur 400 m : on pousse le vélo', res.time_breakdown.walk_m >= 250 && v >= 2 && v <= 4.5,
    `marche ${res.time_breakdown.walk_m} m, ${v.toFixed(1)} km/h dans le mur (2-4,5)`);
}

function s8() {
  const route = straight(1000, (d) => 500 - 0.18 * d, { surface: 4 });
  const res = predict(route, { rider: JO });
  const v = 1 / (res.total_time_s / 3600);
  record('S8', 'P', 'Descente en terre à −18 % : lente ou à pied', v <= 15, `${v.toFixed(1)} km/h moyen (≤ 15), marche ${res.time_breakdown.walk_m} m`);
}

function s9() {
  const t = (surface: number) => predict(straight(20_000, () => 100, { step: 50, surface }), { rider: JO }).total_time_s;
  const a = t(1), g = t(3), d = t(4);
  record('S9', 'P', '20 km de plat : asphalte / gravier / terre', g / a >= 1.08 && g / a <= 1.35 && d / a >= 1.2 && d / a <= 1.7,
    `gravier ×${(g / a).toFixed(2)} (1,08-1,35)  terre ×${(d / a).toFixed(2)} (1,2-1,7)`);
}

function s10() {
  const t = (base: number) => predict(straight(8000, (d) => base + 0.07 * d), { rider: JO }).total_time_s;
  const r = t(2000) / t(0);
  record('S10', 'H', 'Même col (8 km à 7 %) au niveau de la mer et à 2000 m', r >= 1.01 && r <= 1.1, `×${r.toFixed(3)} en altitude (1,01-1,10)`);
}

function s11() {
  const route = straight(60_000, () => 100, { step: 50 });
  const res = predict(route, { rider: JO });
  const kmTime = (k: number) => res.points.filter((p: any) => p.distance_m >= k * 1000 && p.distance_m < (k + 1) * 1000).reduce((s: number, p: any) => s + p.segment_time_s, 0);
  const first = kmTime(1), steadyKm = kmTime(20), later = kmTime(40);
  record('S11', 'H', 'Échauffement au départ, régime établi ensuite', first > steadyKm && Math.abs(later / steadyKm - 1) < 0.005,
    `km 2 ${first.toFixed(0)} s > km 21 ${steadyKm.toFixed(0)} s ≈ km 41 ${later.toFixed(0)} s`);
}

function s12() {
  const prof = (d: number) => 400 + 80 * Math.sin(d / 3000);
  const route = straight(600_000, prof, { step: 100 });
  const res = predict(route, { rider: JO, start_time_h: 6 });
  const mid = res.points.find((p: any) => p.distance_m >= 300_000);
  const a1 = mid.elapsed_time_s;
  const a2 = res.total_time_s - mid.elapsed_time_s;
  record('S12', 'P', '600 km d\'une traite : fatigue d\'endurance et creux nocturne', a2 > a1 * 1.05,
    `1re moitié ${formatHms(a1)}, 2e ${formatHms(a2)} (${pct((a2 / a1 - 1) * 100)})`);
}

function s13() {
  const text = fs.readFileSync('C:/Users/simon/Downloads/GT20.gpx', 'utf8');
  const pts: XY[] = [];
  const lat: number[] = [], lon: number[] = [], ele: number[] = [];
  for (const m of text.matchAll(/<(trkpt|rtept)\s+([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
    const la = /lat="([-\d.eE]+)"/.exec(m[2]!); const lo = /lon="([-\d.eE]+)"/.exec(m[2]!);
    if (!la || !lo) continue;
    const e = m[4] ? /<ele>([-\d.eE]+)<\/ele>/.exec(m[4]) : null;
    lat.push(Number(la[1])); lon.push(Number(lo[1])); ele.push(e ? Number(e[1]) : NaN);
  }
  void pts;
  const route: V2Route = { lat: Float64Array.from(lat), lon: Float64Array.from(lon), ele: Float64Array.from(ele), dist: new Float64Array(0), surface: new Uint8Array(0), way: new Uint8Array(0), wind: new Float64Array(0) };
  const levels = ['debutant', 'intermediaire', 'avance', 'expert'];
  const times = levels.map((level) => predict(route, { rider: { preset: { level, gender: 'unspecified' } }, geometry: 'auto' }).total_time_s / 3600);
  const ordered = times.every((t, i) => i === 0 || t < times[i - 1]!);
  record('S13', 'I', 'GT20 (593 km, ~9 800 m D+) par niveau — bandes à valider avec Victor', ordered,
    `${levels.map((l, i) => `${l} ${times[i]!.toFixed(1)} h`).join('  ')}  (ancien moteur : débutant ~36-37,5 h)`);
}

function s14() {
  const flat = straight(20_000, () => 100, { step: 50 });
  const hill = straight(5000, (d) => 0.06 * d);
  const base = silenceConsole(() => predict(flat, { rider: JO })).model;
  const t = (route: V2Route, over: Record<string, number>) => predict(route, { rider: { model: { ...base, ...over } } }).total_time_s;
  const tf = t(flat, {}), th = t(hill, {});
  const checks = [
    ['masse +10 kg (montée)', t(hill, { mass_kg: base.mass_kg + 10 }) > th],
    ['CdA +0,05 (plat)', t(flat, { cda: base.cda + 0.05 }) > tf],
    ['Crr ×1,5 (plat)', t(flat, { crr: base.crr * 1.5 }) > tf],
    ['puissance +10 % (plat)', t(flat, { p_flat_w: base.p_flat_w * 1.1 }) < tf],
    ['puissance +10 % (montée)', t(hill, { p_flat_w: base.p_flat_w * 1.1 }) < th],
  ] as const;
  record('S14', 'H', 'Monotonie (masse, CdA, Crr, puissance)', checks.every(([, ok]) => ok), checks.map(([l, ok]) => `${ok ? '✓' : '✗'} ${l}`).join('  '));
}

function s15() {
  const route = straight(20_000, () => 150, { step: 50 });
  const a = predict(route, { rider: JO }).total_time_s;
  const b = predict(reversed(route), { rider: JO }).total_time_s;
  const prof = (d: number) => 300 + 0.04 * d;
  const climb = predict(straight(5000, prof), { rider: JO }).total_time_s;
  const down = predict(reversed(straight(5000, prof)), { rider: JO }).total_time_s;
  record('S15', 'H', 'Sens de parcours : plat identique, montée plus lente que la descente', Math.abs(a / b - 1) <= 0.005 && climb > down * 1.5,
    `plat A→B ${formatHms(a)} / B→A ${formatHms(b)} ; 5 km à 4 % : montée ${formatHms(climb)}, descente ${formatHms(down)}`);
}

function s16() {
  const prof = (d: number) => 400 + 120 * Math.sin(d / 4000) + 30 * Math.sin(d / 700);
  const route = straight(700_000, prof, { step: 20 });
  const t0 = performance.now();
  predict(route, { rider: JO });
  const ms = performance.now() - t0;
  const t1 = performance.now();
  silenceConsole(() => glue.calibrate_cycling(rides.map((r) => r.bytes), { rider: PRIOR }, () => {}));
  const calMs = performance.now() - t1;
  record('S16', 'H', 'Performance : 700 km (70 000 cellules) et calibration + LOO sur 6 sorties', ms <= 500 && calMs <= 3000,
    `prédiction ${ms.toFixed(0)} ms (≤ 500)  calibration ${calMs.toFixed(0)} ms (≤ 3000)`);
}

function s17() {
  const cases: [string, V2Route, boolean][] = [
    ['2 points', routeFromXY([{ x: 0, y: 0, ele: 0 }, { x: 0, y: 500, ele: 10 }]), true],
    ['altitude absente', { ...straight(5000, () => 0), ele: new Float64Array(501).fill(NaN) }, true],
    ['points dupliqués', routeFromXY([...Array(50)].flatMap((_, i) => [{ x: 0, y: i * 20, ele: i }, { x: 0, y: i * 20, ele: i }])), true],
    ['téléportation de 50 km', routeFromXY([{ x: 0, y: 0, ele: 0 }, { x: 0, y: 100, ele: 0 }, { x: 50_000, y: 100, ele: 0 }, { x: 50_000, y: 300, ele: 0 }]), true],
    ['1 seul point', routeFromXY([{ x: 0, y: 0, ele: 0 }]), false],
  ];
  const lines: string[] = [];
  let ok = true;
  for (const [label, route, shouldWork] of cases) {
    try {
      const res = predict(route, { rider: JO });
      const finite = Number.isFinite(res.total_time_s) && res.points.every((p: any) => Object.values(p).every((v) => Number.isFinite(v as number)));
      ok &&= shouldWork && finite;
      lines.push(`${label} : ${formatHms(res.total_time_s)}${finite ? '' : ' (NON FINI)'}`);
    } catch (e) {
      const trap = e instanceof WebAssembly.RuntimeError;
      ok &&= !shouldWork && !trap;
      lines.push(`${label} : erreur ${trap ? 'WASM (panic)' : 'propre'} « ${String((e as Error).message ?? e).slice(0, 60)} »`);
    }
  }
  record('S17', 'H', 'Entrées dégénérées : pas de panique, sorties finies', ok, lines.join('\n'));
}

function s18() {
  const route = straight(30_000, (d) => 200 + 50 * Math.sin(d / 3000));
  const res = predict(route, { rider: JO });
  // Le moteur ignore toute pause : un champ `pauses` transmis ne change rien.
  const withPauseField = predict(route, { rider: JO, pauses: [{ distance_m: 10_000, duration_s: 1800 }] });
  const pausesIgnored = withPauseField.total_time_s === res.total_time_s && !('wall_time_s' in res);
  const pts = res.points;
  const increasing = pts.every((p: any, i: number) => i === 0 || p.distance_m > pts[i - 1].distance_m);
  const lastOk = Math.abs(pts[pts.length - 1].elapsed_time_s - res.total_time_s) < 0.2;
  const sumOk = Math.abs(pts.reduce((s: number, p: any) => s + p.segment_time_s, 0) - res.total_time_s) < 1;
  const tsVersion = (() => {
    try {
      const src = fs.readFileSync('src/features/fitPredictor/engine/version.ts', 'utf8');
      return Number(/CYCLING_ENGINE_VERSION\s*=\s*(\d+)/.exec(src)?.[1]);
    } catch { return NaN; }
  })();
  const ver = glue.engine_version();
  const ok = increasing && lastOk && sumOk && pausesIgnored && res.stop_time_s === 0 && res.riding_time_s === res.total_time_s
    && res.engine_version === ver && tsVersion === ver;
  record('S18', 'H', 'Contrat de sortie (temps de déplacement seul, sans pause ; points ; version)', ok,
    `distances croissantes ${increasing}, dernier elapsed = total ${lastOk}, Σ segments = total ${sumOk}, stop_time ${res.stop_time_s}, pauses ignorées ${pausesIgnored}, version moteur ${ver} / TS ${tsVersion}`);
}

function s19() {
  const urban = straight(10_000, () => 100, { step: 20, way: () => 4 | 0x40 });
  const rural = straight(10_000, () => 100, { step: 20, way: () => 3 });
  const params = { urban_vmax_kmh: 24, urban_slowdown_every_m: 400, signal_kmh: 15 };
  const tu = predict(urban, { rider: JO, model_params: params }).total_time_s;
  const tr = predict(rural, { rider: JO, model_params: params }).total_time_s;
  const tuDefault = predict(urban, { rider: JO }).total_time_s;
  record('S19', 'H', 'Agglomération (mécanisme, désactivé par défaut) : plus lent qu\'en campagne', tu > tr * 1.05 && Math.abs(tuDefault / tr - 1) < 0.005,
    `activé : ville ${formatHms(tu)} vs campagne ${formatHms(tr)} ; par défaut : ville ${formatHms(tuDefault)}`);
}

function s20() {
  const route = straight(20_000, () => 100, { step: 50 });
  const calm = predict(route, { rider: JO }).total_time_s;
  const head = predict({ ...route, wind: new Float64Array(route.lat.length).fill(5) }, { rider: JO }).total_time_s;
  const tail = predict({ ...route, wind: new Float64Array(route.lat.length).fill(-5) }, { rider: JO }).total_time_s;
  record('S20', 'H', 'Vent de 5 m/s de face / dans le dos', head > calm * 1.15 && tail < calm * 0.92,
    `face ×${(head / calm).toFixed(2)} (> 1,15), dos ×${(tail / calm).toFixed(2)} (< 0,92)`);
}

function s21() {
  const model = { ...silenceConsole(() => predict(straight(1000, () => 0), { rider: JO })).model, warmup_amp: 0 };
  // Petites bosses : ±4 % sur 200 m de longueur d'onde.
  const prof = (d: number) => 100 + (200 * 0.04 / (2 * Math.PI)) * Math.sin((2 * Math.PI * d) / 200);
  const L = 10_000;
  const route = straight(L, prof, { step: 5 });
  const t = predict(route, { rider: { model }, model_params: { ele_sigma_m: 5, ele_median_half_m: 5 } }).total_time_s;
  // Même politique de puissance et même vitesse de confort en descente que le
  // moteur (pente de contexte ≈ 0, pente moyenne ±60 m), mais vitesse
  // d'équilibre instantanée : sans élan.
  const comfort = (gPct: number) => {
    if (gPct >= -1) return Infinity;
    const steep = -gPct;
    let v = Math.min(model.desc_vmax_kmh, model.desc_v1_kmh + model.desc_k_kmh_per_pct * (steep - 1));
    if (steep > model.desc_steep_from_pct) v -= model.desc_steep_drop_kmh_per_pct * (steep - model.desc_steep_from_pct);
    return Math.max(6, v) / 3.6;
  };
  let tRef = 0;
  for (let d = 0; d < L; d += 5) {
    const g = (prof(d + 5) - prof(d)) / 5;
    const gMid = (prof(d + 65) - prof(d - 60)) / 125;
    // Pente de contexte ≈ 0 : puissance du plat (le moteur ne force pas sur une bosse de 50 m).
    const v = steady(model.drivetrain_eff * powerAt(model, 0) * altFactor(100), g, model.mass_kg, model.crr, model.cda, rho(100));
    tRef += 5 / Math.min(v, comfort(gMid * 100));
  }
  record('S21', 'H', 'Élan sur les bosses : plus rapide que la somme des régimes établis', t < tRef * 0.995,
    `moteur ${formatHms(t)} vs régimes établis ${formatHms(tRef)} (${pct((t / tRef - 1) * 100)})`);
}

function s22() {
  const base = silenceConsole(() => predict(straight(1000, () => 0), { rider: JO })).model;
  const truth = { ...base, p_flat_w: base.p_flat_w * 1.15, climb_ratio: 1 + (base.climb_ratio - 1) * 0.85, desc_v1_kmh: base.desc_v1_kmh * 0.9, desc_k_kmh_per_pct: base.desc_k_kmh_per_pct * 0.9, desc_vmax_kmh: base.desc_vmax_kmh * 0.9 };
  const tracks = rides.map((r) => {
    const pred = predict(trackToV2Route(r.track), { rider: { model: truth }, geometry: 'gps' });
    const total = r.track[r.track.length - 1]!.d;
    const pts = pred.points;
    let j = 0;
    const t = r.track.map((p) => {
      const f = (p.d / total) * pred.total_distance_m;
      while (j + 1 < pts.length && pts[j + 1].distance_m <= f) j++;
      const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
      const span = b.distance_m - a.distance_m;
      return span > 0 ? a.elapsed_time_s + (b.elapsed_time_s - a.elapsed_time_s) * (f - a.distance_m) / span : a.elapsed_time_s;
    });
    return { lat: r.track.map((p) => p.lat), lon: r.track.map((p) => p.lon), ele: r.track.map((p) => p.ele), dist: r.track.map((p) => p.d), t };
  });
  const res = silenceConsole(() => glue.calibrate_cycling_tracks(tracks, { rider: JO }));
  const m = res.model;
  const flat = m.p_flat_w / truth.p_flat_w;
  const climb = (m.p_flat_w * m.climb_ratio) / (truth.p_flat_w * truth.climb_ratio);
  const desc = m.desc_vmax_kmh / truth.desc_vmax_kmh;
  const ok = Math.abs(flat - 1) <= 0.05 && Math.abs(climb - 1) <= 0.05 && Math.abs(desc - 1) <= 0.07;
  record('S22', 'H', 'Calibration : retrouve des paramètres connus (sorties synthétiques)', ok,
    `puissance plat ×${flat.toFixed(3)}  puissance montée ×${climb.toFixed(3)}  descente ×${desc.toFixed(3)} de la vérité (±5/5/7 %)  in-sample ${res.report.in_sample_median_abs_pct} %`);
}

function s23() {
  const d3b = rides.find((r) => r.id === 'D3b')!;
  const rep = calibrate([d3b]).report;
  const [mp, mc, md] = rep.multipliers;
  record('S23', 'H', 'Une seule sortie courte et plate : la calibration reste près du prior en montée/descente', Math.abs(Math.log(mc)) <= 0.15 && Math.abs(Math.log(md)) <= 0.15,
    `puissance ×${mp.toFixed(2)}  montée ×${mc.toFixed(2)}  descente ×${md.toFixed(2)}  avertissements [${rep.warnings.join(', ')}]`);
}

async function s24() {
  const old = await loadPkg(BASELINE_PKG);
  const gpx = new Uint8Array(fs.readFileSync('C:/Users/simon/Downloads/GT20.gpx'));
  const cfg = { discipline: 'trail', level: 'intermediaire' };
  const a = silenceConsole(() => old.predict_run([], gpx, cfg, () => {})).total_time_s;
  const b = silenceConsole(() => glue.predict_run([], gpx, cfg, () => {})).total_time_s;
  record('S24', 'H', 'Course à pied (predict_run) inchangée', Math.abs(a - b) < 1e-6, `ancien ${formatHms(a)} / nouveau ${formatHms(b)}`);
}

// ── Exécution ───────────────────────────────────────────────────────────────
async function main() {
  glue = await loadPkg(arg('pkg'));
  rides = loadRides();
  const scenarios: [string, () => unknown][] = [
    ['R1', r1r2r3], ['R4', r4], ['R6', r6], ['R7', r7r8], ['R9', r9], ['R10', r10], ['R11', r11],
    ['S1', s1], ['S2', s2], ['S3', s3], ['S4', s4], ['S5', s5], ['S6', s6], ['S7', s7], ['S8', s8], ['S9', s9], ['S10', s10],
    ['S11', s11], ['S12', s12], ['S13', s13], ['S14', s14], ['S15', s15], ['S16', s16], ['S17', s17], ['S18', s18],
    ['S19', s19], ['S20', s20], ['S21', s21], ['S22', s22], ['S23', s23], ['S24', s24],
  ];
  const slow = new Set(['R11', 'R9', 'S16', 'S22']);
  for (const [id, fn] of scenarios) {
    if (ONLY && !ONLY.includes(id)) continue;
    if (QUICK && slow.has(id)) continue;
    try {
      await fn();
    } catch (e) {
      record(id, 'H', 'exception', false, String((e as Error).stack ?? e).slice(0, 400));
    }
  }
  const hardFail = outcomes.filter((o) => o.kind === 'H' && !o.pass);
  const softMiss = outcomes.filter((o) => o.kind === 'P' && !o.pass);
  console.log(`\n${outcomes.length} scénarios — critères durs en échec : ${hardFail.length}${hardFail.length ? ` (${hardFail.map((o) => o.id).join(', ')})` : ''} — cibles produit manquées : ${softMiss.length}${softMiss.length ? ` (${softMiss.map((o) => o.id).join(', ')})` : ''}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(outcomes, null, 2));
  process.exit(hardFail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
