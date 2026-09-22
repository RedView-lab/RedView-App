/**
 * Expérience : impact de l'absence de puissance sur la prédiction.
 *
 * Méthode : on simule un coureur physiquement cohérent (P(t) = FTP × décroissance
 * de fatigue, vitesse = résolution du bilan de puissance, FC corrélée à l'intensité),
 * on génère des FIT d'entraînement + un FIT de validation hors entraînement, puis on
 * fait tourner le VRAI moteur WASM (predict) sur le même jeu de données :
 *   A. FIT avec puissance          → chemin "ensemble KNN + physique"
 *   B. FIT sans puissance          → chemin "KNN seul"
 *   C. FIT sans puissance, 1 seul  → chemin "bins empiriques" (KNN inutilisable)
 * et on compare le temps prédit au temps réellement simulé.
 */
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.resolve('src/features/fitPredictor/engine/pkg');
const glue = await import(new URL('file://' + path.join(PKG, 'redviewalgo.js').replace(/\\/g, '/')));
glue.initSync(fs.readFileSync(path.join(PKG, 'redviewalgo_bg.wasm')));

// ─────────────────────────── FIT encoder ───────────────────────────
const B = { SINT8: 0x01, UINT8: 0x02, SINT32: 0x05, UINT16: 0x04, UINT32: 0x06 };
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb400, 0x5000, 0x9c01, 0x8800, 0x4400,
];
function fitCrc16(data) {
  let crc = 0;
  for (const byte of data) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc ^= tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc ^= tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}
const SEMI = 2147483648 / 180;
const toSemi = (deg) => Math.round(deg * SEMI);

const RECORD_FIELDS = [
  [253, 4, B.UINT32], [0, 4, B.SINT32], [1, 4, B.SINT32], [2, 2, B.UINT16],
  [3, 1, B.UINT8], [4, 1, B.UINT8], [5, 4, B.UINT32], [6, 2, B.UINT16],
  [7, 2, B.UINT16], [13, 1, B.SINT8], [17, 4, B.UINT32], [18, 4, B.UINT32],
];

/** @param {{lat:number,lon:number,alt:number,hr:number,cad:number,dist:number,speed:number,power:number,temp:number,ts:number}[]} samples */
function encodeFit(samples, { withPower, withHr = true }) {
  const body = [];
  const u8 = (v) => body.push(v & 0xff);
  const u16 = (v) => body.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => body.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const i32 = (v) => u32(v < 0 ? v + 4294967296 : v);

  // FileId definition (local 1) + data
  u8(0x41); u8(0); u8(0); u16(0); u8(2);
  body.push(253, 4, B.UINT32, 0, 1, B.UINT8);
  u8(0x01); u32(samples[0].ts); u8(4);

  // Record definition (local 0)
  u8(0x40); u8(0); u8(0); u16(20); u8(RECORD_FIELDS.length);
  for (const [n, s, b] of RECORD_FIELDS) body.push(n, s, b);

  for (const p of samples) {
    u8(0x00);
    u32(p.ts);
    i32(toSemi(p.lat));
    i32(toSemi(p.lon));
    u16(Math.round((p.alt + 500) * 5));
    u8(withHr ? Math.max(0, Math.min(255, Math.round(p.hr))) : 0xff);
    u8(Math.max(0, Math.min(255, Math.round(p.cad))));
    u32(Math.round(p.dist * 100));
    u16(Math.round(p.speed * 1000));
    const pw = withPower ? Math.max(0, Math.min(65534, Math.round(p.power))) : 0xffff;
    u16(pw);
    body.push(Math.round(p.temp) & 0xff);
    u32(Math.round((p.alt + 500) * 5));
    u32(Math.round(p.speed * 1000));
  }

  const file = [12, 0x10, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
  file[2] = 2132 & 0xff; file[3] = 2132 >> 8;
  const len = body.length;
  file[4] = len & 0xff; file[5] = (len >> 8) & 0xff;
  file[6] = (len >> 16) & 0xff; file[7] = (len >> 24) & 0xff;
  const all = file.concat(body);
  const crc = fitCrc16(all);
  all.push(crc & 0xff, (crc >> 8) & 0xff);
  return Uint8Array.from(all);
}

// ─────────────────────── Physique & coureur simulé ───────────────────────
const G = 9.80665;
const RHO0 = 1.225;
const DRIVETRAIN = 0.97;
const RIDER = { mass: 78, cda: 0.32, crr: 0.005, ftp: 260, hrRest: 55, hrMax: 186 };

const airDensity = (alt) => RHO0 * Math.pow(1 - 0.0000226 * Math.max(0, Math.min(11000, alt)), 4.256);

function requiredPower(v, gradePct, alt, r = RIDER) {
  const theta = Math.atan(gradePct / 100);
  const rho = airDensity(alt);
  const fg = r.mass * G * Math.sin(theta);
  const fr = r.crr * r.mass * G * Math.cos(theta);
  const fa = 0.5 * rho * r.cda * v * v;
  // Signed: negative when gravity assists (descent) — required to solve coasting.
  return ((fg + fr + fa) * v) / DRIVETRAIN;
}
function speedForPower(power, gradePct, alt, r = RIDER) {
  let lo = 0.1, hi = 32;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (requiredPower(mid, gradePct, alt, r) < power) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ───────────────────────── Générateur de trace ─────────────────────────
function makeRoute(seed, targetKm) {
  const rnd = (() => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const amps = [0.35 + rnd() * 0.5, 0.25 + rnd() * 0.4, 0.12 + rnd() * 0.2, 0.05 + rnd() * 0.1];
  const baseAlt = 320 + rnd() * 900;
  const climbBias = 0.25 + rnd() * 0.7;
  const points = [];
  let dist = 0, lat = 45.1 + rnd() * 1.5, lon = 6.0 + rnd() * 1.2;
  const targetM = targetKm * 1000;
  while (dist < targetM) {
    const km = dist / 1000;
    let alt = baseAlt + climbBias * 130 * Math.sin(km / 9 + ph[0])
      + amps[0] * 190 * Math.sin(km / 2.3 + ph[1])
      + amps[1] * 95 * Math.sin(km / 0.75 + ph[2])
      + amps[2] * 34 * Math.sin(km / 0.21 + ph[3])
      + amps[3] * 9 * Math.sin(km / 0.05);
    points.push({ dist, lat, lon, alt });
    const step = 14 + rnd() * 46;
    dist += step;
    lat += (step / 111000) * Math.cos(km / 3 + ph[0]);
    lon += (step / 78000) * Math.sin(km / 3 + ph[0]);
  }
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const n = points[Math.min(i + 1, points.length - 1)];
    const d = Math.max(1, n.dist - p.dist);
    p.grade = ((n.alt - p.alt) / d) * 100;
  }
  // Pente lissée sur ~150 m (comme une vraie route, et comparable au lissage GPX
  // du moteur) — sinon la simulation réagit à un bruit que le moteur, lui, lisse.
  const half = 3;
  for (let i = 0; i < points.length; i++) {
    let g = 0, w = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
      g += points[j].grade * (1 - Math.abs(j - i) / (half + 1));
      w += 1 - Math.abs(j - i) / (half + 1);
    }
    points[i].gradeSmooth = g / w;
  }
  return points;
}

/** Simule la sortie du coureur sur une trace. */
function simulate(route) {
  const samples = [];
  let t = 0, dist = 0, hr = RIDER.hrRest + 25;
  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    const grade = p.gradeSmooth ?? p.grade ?? 0;
    const h = t / 3600;
    // Décroissance de fatigue : FTP → ~70 % sur 6 h
    let target = RIDER.ftp * (0.70 + 0.30 * Math.exp(-h / 5.5));
    if (grade > 2) target *= 1.06;
    if (grade < -3) target = 0; // roue libre en descente
    const v = speedForPower(target, grade, p.alt);
    const power = Math.max(0, requiredPower(v, grade, p.alt));
    // FC : corrélée à l'intensité + dérive cardiaque
    const intensity = Math.max(0, Math.min(1.25, power / RIDER.ftp));
    const hrTarget = RIDER.hrRest + (RIDER.hrMax - RIDER.hrRest)
      * Math.pow(intensity, 0.95) * (1 + 0.06 * h);
    hr += (Math.max(RIDER.hrRest, Math.min(RIDER.hrMax, hrTarget)) - hr) * 0.25;
    const cad = grade > 4 ? 68 : grade > 0 ? 78 : 88;
    samples.push({
      ts: Math.round(p.ts = 1_000_000_000 + t),
      lat: p.lat, lon: p.lon, alt: p.alt,
      hr, cad, dist: p.dist, speed: v, power,
      temp: 18 + 6 * Math.sin(h / 3),
    });
    if (i < route.length - 1) {
      const seg = Math.max(1, route[i + 1].dist - p.dist);
      t += seg / Math.max(0.5, v);
    }
  }
  return { samples, totalTimeS: t, distanceM: route[route.length - 1].dist };
}

function toGpx(route, name) {
  const pts = route.map((p) =>
    `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.alt.toFixed(2)}</ele></trkpt>`
  ).join('\n');
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RedView" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk>\n    <name>${name}</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>\n</gpx>`
  );
}

// ───────────────────────────── Jeux de données ─────────────────────────────
const hms = (s) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
const kph = (m, s) => ((m / s) * 3.6).toFixed(2);

function buildDataset(trainingSpecs, valSpec) {
  const training = trainingSpecs.map(({ seed, km }) => {
    const route = makeRoute(seed, km);
    return { route, sim: simulate(route) };
  });
  const valRoute = makeRoute(valSpec.seed, valSpec.km);
  const valSim = simulate(valRoute);
  return { training, valRoute, valSim, gpx: toGpx(valRoute, 'validation') };
}

function run(label, ds, fitFiles, config) {
  const t0 = performance.now();
  const res = glue.predict(fitFiles, ds.gpx, config, null);
  const ms = performance.now() - t0;
  const errPct = ((res.total_time_s - ds.valSim.totalTimeS) / ds.valSim.totalTimeS) * 100;
  console.log(
    `  ${label.padEnd(42)} FTP ${String(Math.round(res.rider_profile.ftp_w)).padStart(3)} W · ` +
    `masse ${res.rider_profile.mass_kg.toFixed(1)} kg · has_power=${String(res.rider_profile.has_power).padEnd(5)} | ` +
    `prédit ${hms(res.total_time_s)} vs réel ${hms(ds.valSim.totalTimeS)} → ${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)} % ` +
    `(bande ±${(((res.total_time_high_s - res.total_time_low_s) / 2 / res.total_time_s) * 100).toFixed(0)} %, ${ms.toFixed(0)} ms)`
  );
  return errPct;
}

function scenario(title, trainingSpecs, valSpec) {
  const ds = buildDataset(trainingSpecs, valSpec);
  const cumKm = trainingSpecs.reduce((a, t) => a + t.km, 0);
  console.log(`\n################ ${title} ################`);
  console.log(`Entraînement : ${trainingSpecs.length} activités / ${cumKm} km cumulés (max ${Math.max(...trainingSpecs.map((t) => t.km))} km)`);
  console.log(`Validation   : ${valSpec.km} km, temps réel simulé ${hms(ds.valSim.totalTimeS)} (${kph(ds.valSim.distanceM, ds.valSim.totalTimeS)} km/h)`);
  const withPower = ds.training.map((t) => encodeFit(t.sim.samples, { withPower: true }));
  const noPower = ds.training.map((t) => encodeFit(t.sim.samples, { withPower: false }));
  const shortNoPower = [encodeFit(ds.training[ds.training.length - 1].sim.samples.slice(0, 40), { withPower: false })];
  const out = {};
  out.A = run('A. avec puissance', ds, withPower, {});
  out.B = run('B. sans puissance', ds, noPower, {});
  out.B2 = run('B2. sans puissance + poids utilisateur', ds, noPower, { mass_kg: 78 });
  out.B3 = run('B3. sans puissance + FTP utilisateur', ds, noPower, { mass_kg: 78, ftp_w: 260 });
  out.C = run('C. sans puissance, KNN inutilisable', ds, shortNoPower, {});
  const noPowerNoHr = ds.training.map((t) => encodeFit(t.sim.samples, { withPower: false, withHr: false }));
  out.D = run('D. sans puissance NI FC (FC invalidée)', ds, noPowerNoHr, {});
  return out;
}

const short = scenario(
  'SCÉNARIO 1 — validation dans l\'enveloppe d\'entraînement',
  [{ seed: 11, km: 62 }, { seed: 27, km: 88 }, { seed: 41, km: 47 }, { seed: 63, km: 120 }],
  { seed: 97, km: 104 }
);

const ultra = scenario(
  'SCÉNARIO 2 — extrapolation : sortie 2,5× plus longue que l\'historique',
  [{ seed: 11, km: 45 }, { seed: 27, km: 58 }, { seed: 41, km: 38 }, { seed: 63, km: 72 }],
  { seed: 97, km: 268 }
);

function diagnose(label, ds, fitFiles, config) {
  const res = glue.predict(fitFiles, ds.gpx, config, null);
  const actual = ds.valSim.samples;
  const atDist = (d) => {
    let i = 0;
    while (i < actual.length - 1 && actual[i + 1].dist < d) i++;
    return actual[i];
  };
  const total = res.total_distance_m;
  console.log(`\n  Dérive du temps cumulé — ${label}`);
  console.log('     km     réel       prédit      ratio   fatigue  distEff  knnConf');
  for (const frac of [0.05, 0.25, 0.5, 0.75, 1.0]) {
    const d = total * frac;
    let p = res.points[0];
    for (const q of res.points) { if (q.distance_m <= d) p = q; else break; }
    const a = atDist(d);
    const actualT = a.ts - actual[0].ts;
    const ratio = p.elapsed_time_s / Math.max(1, actualT);
    console.log(
      `    ${(d / 1000).toFixed(0).padStart(5)}   ${hms(actualT).padStart(7)}   ${hms(p.elapsed_time_s).padStart(7)}` +
      `     ${ratio.toFixed(2).padStart(5)}    ${(p.fatigue_factor ?? 0).toFixed(3)}   ${(p.distance_eff_factor ?? 1).toFixed(3)}` +
      `    ${(p.knn_confidence ?? 0).toFixed(3)}`
    );
  }
  return res;
}

console.log('\n=== DIAGNOSTIC — où part l\'erreur (scénario 2, extrapolation) ===');
const ds2 = buildDataset([{ seed: 11, km: 45 }, { seed: 27, km: 58 }, { seed: 41, km: 38 }, { seed: 63, km: 72 }], { seed: 97, km: 268 });
const fits2NoPower = ds2.training.map((t) => encodeFit(t.sim.samples, { withPower: false }));
const fits2Power = ds2.training.map((t) => encodeFit(t.sim.samples, { withPower: true }));
diagnose('A. avec puissance', ds2, fits2Power, {});
diagnose('B. sans puissance (KNN seul)', ds2, fits2NoPower, {});

console.log('\n=== Synthèse des écarts vs temps réel simulé ===');
console.log('  scénario                              A(W)   B(sans W)  B+poids   B+FTP    C(bins)  D(sans FC)');
for (const [name, r] of [['1. dans l\'enveloppe', short], ['2. extrapolation longue', ultra]]) {
  console.log(
    `  ${name.padEnd(36)} ` +
    [r.A, r.B, r.B2, r.B3, r.C, r.D].map((v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`.padStart(9)).join('')
  );
}


// ───────────────── Balayage : volume d'historique nécessaire ─────────────────
console.log('\n\n=== BALAYAGE — volume d\'historique FIT (sans puissance) ===');
const SEEDS = [11, 27, 41, 63, 82, 104, 131, 158];
const LENGTHS = [40, 55, 70, 85, 50, 65, 95, 60];
for (const [label, valKm] of [['104 km', 104], ['268 km', 268]]) {
  console.log(`\n  Cible ${label}`);
  console.log('    nb FIT   km cumulés   écart temps');
  for (const n of [1, 2, 4, 8]) {
    const specs = SEEDS.slice(0, n).map((seed, i) => ({ seed, km: LENGTHS[i] }));
    const ds = buildDataset(specs, { seed: 97, km: valKm });
    const fits = ds.training.map((t) => encodeFit(t.sim.samples, { withPower: false, withHr: false }));
    const res = glue.predict(fits, ds.gpx, {}, null);
    const err = ((res.total_time_s - ds.valSim.totalTimeS) / ds.valSim.totalTimeS) * 100;
    const cum = specs.reduce((a, s) => a + s.km, 0);
    console.log(`    ${String(n).padStart(4)}     ${String(cum).padStart(6)} km    ${err >= 0 ? '+' : ''}${err.toFixed(1)} %`);
  }
}

// ───────── Balayage : longueur de la PLUS LONGUE sortie d'entraînement ─────────
console.log('\n\n=== BALAYAGE — longueur de la plus longue sortie (cible 268 km, sans puissance) ===');
console.log('    plus longue sortie   km cumulés   écart temps');
for (const longest of [60, 100, 140, 180, 220, 260]) {
  const specs = [{ seed: 11, km: 45 }, { seed: 27, km: 60 }, { seed: 41, km: longest }];
  const ds = buildDataset(specs, { seed: 97, km: 268 });
  const fits = ds.training.map((t) => encodeFit(t.sim.samples, { withPower: false, withHr: false }));
  const res = glue.predict(fits, ds.gpx, {}, null);
  const err = ((res.total_time_s - ds.valSim.totalTimeS) / ds.valSim.totalTimeS) * 100;
  const cum = specs.reduce((a, s) => a + s.km, 0);
  console.log(`    ${String(longest).padStart(16)} km   ${String(cum).padStart(6)} km    ${err >= 0 ? '+' : ''}${err.toFixed(1)} %`);
}
