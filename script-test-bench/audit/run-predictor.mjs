/**
 * Audit du moteur de prédiction course à pied (`predict_run`).
 *
 * Méthode : on simule un coureur « vrai » (allure de référence, décroissance
 * d'endurance, marche active au-delà d'une pente seuil à VAM constante,
 * descentes plafonnées, bruit), on encode ses sorties en FIT (avec le champ
 * sport de la Session et la cadence), puis on fait tourner le VRAI moteur
 * WASM sur un parcours de validation plus long, hors entraînement :
 *   A. avec les FIT course            → profil appris + KNN
 *   B. sans FIT, niveau seul          → valeurs par défaut
 *   C. sans FIT, chrono de référence  → Riegel
 *   D. FIT enregistrés en « cycling » → doivent être ignorés
 * Plus des contrôles de cohérence sans FIT (10 km, marathon, monotonie).
 *
 * Usage : node script-test-bench/audit/run-predictor.mjs [dossier-pkg]
 */
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.resolve(process.argv[2] ?? 'src/features/fitPredictor/engine/pkg');
const glue = await import(new URL('file://' + path.join(PKG, 'redviewalgo.js').replace(/\\/g, '/')));
glue.initSync({ module: fs.readFileSync(path.join(PKG, 'redviewalgo_bg.wasm')) });
const quiet = console.log;
console.log = () => {};
const out = (...a) => quiet(...a);

// ─────────────────────────── Encodeur FIT ───────────────────────────
const B = { SINT8: 0x01, UINT8: 0x02, UINT16: 0x04, SINT32: 0x05, UINT32: 0x06, ENUM: 0x00 };
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
const toSemi = (deg) => Math.round(deg * (2147483648 / 180));
const RECORD_FIELDS = [
  [253, 4, B.UINT32], [0, 4, B.SINT32], [1, 4, B.SINT32], [2, 2, B.UINT16],
  [3, 1, B.UINT8], [4, 1, B.UINT8], [5, 4, B.UINT32], [6, 2, B.UINT16],
];

/** Codes de sport FIT : 1 course à pied, 2 vélo. */
function encodeFit(samples, sport) {
  const body = [];
  const u8 = (v) => body.push(v & 0xff);
  const u16 = (v) => body.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => body.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  const i32 = (v) => u32(v < 0 ? v + 4294967296 : v);

  // FileId (local 1)
  u8(0x41); u8(0); u8(0); u16(0); u8(2);
  body.push(253, 4, B.UINT32, 0, 1, B.ENUM);
  u8(0x01); u32(samples[0].ts); u8(4);

  // Record (local 0)
  u8(0x40); u8(0); u8(0); u16(20); u8(RECORD_FIELDS.length);
  for (const [n, s, b] of RECORD_FIELDS) body.push(n, s, b);
  for (const p of samples) {
    u8(0x00);
    u32(p.ts);
    i32(toSemi(p.lat));
    i32(toSemi(p.lon));
    u16(Math.round((p.alt + 500) * 5));
    u8(Math.round(p.hr));
    u8(Math.round(p.cad));
    u32(Math.round(p.dist * 100));
    u16(Math.round(p.speed * 1000));
  }

  // Session (local 2) : horodatage + sport
  u8(0x42); u8(0); u8(0); u16(18); u8(2);
  body.push(253, 4, B.UINT32, 5, 1, B.ENUM);
  u8(0x02); u32(samples[samples.length - 1].ts); u8(sport);

  const header = [12, 0x10, 2132 & 0xff, 2132 >> 8, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
  const len = body.length;
  header[4] = len & 0xff; header[5] = (len >> 8) & 0xff;
  header[6] = (len >> 16) & 0xff; header[7] = (len >> 24) & 0xff;
  const all = header.concat(body);
  const crc = fitCrc16(all);
  all.push(crc & 0xff, (crc >> 8) & 0xff);
  return Uint8Array.from(all);
}

// ───────────────────────── Parcours vallonné ─────────────────────────
function makeRoute(seed, km, steepness = 1) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const pts = [];
  for (let d = 0; d <= km * 1000; d += 20) {
    const k = d / 1000;
    const alt = 800
      + steepness * (260 * Math.sin(k / 1.6 + ph[0]) + 70 * Math.sin(k / 0.45 + ph[1]) + 12 * Math.sin(k / 0.09 + ph[2]));
    pts.push({ dist: d, lat: 45.5 + d / 111195, lon: 6.5, alt });
  }
  return pts;
}

const gpxOf = (route) => new TextEncoder().encode(
  '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>'
  + route.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon}"><ele>${p.alt.toFixed(1)}</ele></trkpt>`).join('')
  + '</trkseg></trk></gpx>',
);

// ───────────────────────── Coureur simulé ─────────────────────────
const TRUE = { vref: 11.5 / 3.6, k: 0.09, walkPct: 14, vam: 820, descentCap: 1.15 };
const effort = (g) => {
  const c = Math.max(-22, Math.min(16, g));
  const f = 1 + 0.034 * c + 0.0021 * c * c;
  const slope = g < -22 ? 0.034 + 0.0042 * -22 : g > 16 ? 0.034 + 0.0042 * 16 : 0;
  return f + slope * (g - c);
};

/** Simule une course sur `route` ; renvoie les échantillons FIT (1 par pas de route) et le temps en mouvement. */
function simulate(route, seed) {
  let s = seed;
  const noise = () => 1 + ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 0.08;
  const samples = [];
  let t = 0;
  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    const nxt = route[Math.min(i + 3, route.length - 1)];
    const prv = route[Math.max(i - 3, 0)];
    const g = nxt.dist > prv.dist ? ((nxt.alt - prv.alt) / (nxt.dist - prv.dist)) * 100 : 0;
    const h = t / 3600;
    const vflat = TRUE.vref * (h > 1 ? Math.pow(h, -TRUE.k) : 1);
    let v;
    let walking = false;
    if (g >= TRUE.walkPct) {
      walking = true;
      v = Math.min(6 / 3.6, (TRUE.vam * (h > 1 ? Math.pow(h, -TRUE.k) : 1)) / 3600 / (g / 100));
    } else if (g < 0) {
      v = Math.min(vflat / effort(g), vflat * TRUE.descentCap * (g < -15 ? 1 - 2 * (-g - 15) / 100 : 1));
    } else {
      v = vflat / effort(g);
    }
    v *= noise();
    samples.push({
      ts: 1_000_000_000 + Math.round(t),
      lat: p.lat, lon: p.lon, alt: p.alt, dist: p.dist,
      speed: v, hr: 150, cad: walking ? 55 : 86,
    });
    if (i < route.length - 1) t += (route[i + 1].dist - p.dist) / v;
  }
  return { samples, timeS: t };
}

const fmt = (sec) => `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const pct = (pred, real) => `${pred >= real ? '+' : ''}${(((pred - real) / real) * 100).toFixed(1)} %`;
const predict = (fits, gpx, cfg) => glue.predict_run(fits, gpx, { start_time_h: 8, ...cfg }, null);

let failures = 0;
const check = (label, ok, detail) => {
  out(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// ── Entraînement : 5 sorties de 12 à 22 km ──
const training = [0, 1, 2, 3, 4].map((i) => {
  const route = makeRoute(11 + i * 7, 12 + i * 2.5, 0.9 + i * 0.05);
  return simulate(route, 100 + i);
});
const runFits = training.map((r) => encodeFit(r.samples, 1));
const bikeFits = training.map((r) => encodeFit(r.samples, 2));

// ── Validation : 42 km, plus long que tout l'entraînement ──
const valRoute = makeRoute(999, 42, 1.0);
const real = simulate(valRoute, 4242);
const valGpx = gpxOf(valRoute);
out(`Validation : 42 km, temps réel simulé ${fmt(real.timeS)}`);

const a = predict(runFits, valGpx, { discipline: 'trail', level: 'intermediaire', technicality: 0 });
const rp = a.runner_profile;
out(`  profil appris : vref ${rp.v_ref_kmh.toFixed(2)} km/h (${rp.v_ref_source}, vrai ${(TRUE.vref * 3.6).toFixed(2)}) · marche > ${rp.walk_threshold_pct.toFixed(0)} % (vrai ${TRUE.walkPct}) · VAM ${rp.walk_vam_mh.toFixed(0)} (vrai ${TRUE.vam}) · k ${rp.riegel_k.toFixed(3)} · KNN ${rp.knn_samples}`);
check('A. avec FIT course : écart < 10 %', Math.abs(a.total_time_s - real.timeS) / real.timeS < 0.10,
  `prédit ${fmt(a.total_time_s)} (${pct(a.total_time_s, real.timeS)})`);
check('A. vref apprise à ±12 %', Math.abs(rp.v_ref_kmh / 3.6 - TRUE.vref) / TRUE.vref < 0.12);
check('A. seuil de marche appris à ±4 pts', Math.abs(rp.walk_threshold_pct - TRUE.walkPct) <= 4);

const b = predict([], valGpx, { discipline: 'trail', level: 'intermediaire', technicality: 0 });
out(`  B. sans FIT, niveau intermédiaire : ${fmt(b.total_time_s)} (${pct(b.total_time_s, real.timeS)})`);

const d = predict(bikeFits, valGpx, { discipline: 'trail', level: 'intermediaire', technicality: 0 });
check('D. FIT « cycling » ignorés', d.runner_profile.n_ignored === bikeFits.length && d.runner_profile.v_ref_source === 'level',
  `ignorés ${d.runner_profile.n_ignored}/${bikeFits.length}`);

// ── Cohérence sans FIT ──
const flat = (km) => gpxOf(makeRoute(1, km, 0));
const t10 = ['debutant', 'intermediaire', 'avance', 'expert']
  .map((level) => predict([], flat(10), { discipline: 'running', level }).total_time_s);
check('10 km plat : plus rapide à chaque niveau', t10.every((t, i) => i === 0 || t < t10[i - 1]), t10.map(fmt).join(' / '));

const riegel = 2400 * Math.pow(42.195 / 10, 1.06);
const m = predict([], flat(42.195), { discipline: 'running', ref_distance_m: 10000, ref_time_s: 2400 });
check('Marathon depuis 10 km en 40:00 ≈ Riegel ±5 %', Math.abs(m.total_time_s - riegel) / riegel < 0.05,
  `${fmt(m.total_time_s)} vs Riegel ${fmt(riegel)}`);

const vmas = [12, 15, 18].map((vma) => predict([], flat(21.1), { discipline: 'running', vma_kmh: vma }).total_time_s);
check('Semi : plus de VMA → plus rapide', vmas[0] > vmas[1] && vmas[1] > vmas[2], vmas.map(fmt).join(' / '));

const techs = [0, 0.5, 1].map((technicality) => predict([], valGpx, { discipline: 'trail', level: 'avance', technicality }).total_time_s);
check('Trail : plus technique → plus lent', techs[0] < techs[1] && techs[1] < techs[2], techs.map(fmt).join(' / '));

const noPower = a.points.every((p) => p.predicted_power_w === 0);
check('Pas de puissance dans les points', noPower);

out(failures === 0 ? '\nTous les contrôles passent.' : `\n${failures} contrôle(s) en échec.`);
process.exitCode = failures === 0 ? 0 : 1;
