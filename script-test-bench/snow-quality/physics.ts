// ============================================================================
// Snow engine v2 — deterministic physics checks (idealised terrains)
// ============================================================================

import { DEFAULT_SNOW_ENGINE_CONFIG, type SnowEngineConfig } from '../../src/features/snow/lib/engine/config';
import { holdingDepthCm, snowSlide } from '../../src/features/snow/lib/engine/gravity';
import type { WorkGrid } from '../../src/features/snow/lib/engine/grid';
import { computeSnowDistribution } from '../../src/features/snow/lib/engine/pipeline';
import { sunPosition } from '../../src/features/snow/lib/engine/radiation';
import type { CoarseSnowGrid, SnowEngineInput, SnowObservation, WeatherHistory } from '../../src/features/snow/lib/engine/types';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const LON0 = 6.9;
const LAT0 = 45.95;
const M_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const M_LAT = 110_540;

function idealInput(
  z: (x: number, y: number) => number,
  size: number,
  n: number,
  aromeHs: (lon: number, lat: number, oro: number) => number,
  oro: (x: number, y: number) => number,
  extra: Partial<SnowEngineInput> = {},
  config: Partial<SnowEngineConfig> = {},
): SnowEngineInput {
  const cell = size / (n - 1);
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) data[j * n + i] = z(i * cell - size / 2, j * cell - size / 2);
  const half = size / 2;
  const corners: SnowEngineInput['geo']['corners'] = [
    { lon: LON0 - half / M_LON, lat: LAT0 - half / M_LAT },
    { lon: LON0 + half / M_LON, lat: LAT0 - half / M_LAT },
    { lon: LON0 + half / M_LON, lat: LAT0 + half / M_LAT },
    { lon: LON0 - half / M_LON, lat: LAT0 + half / M_LAT },
  ];
  const aw = 41, ah = 41;
  const lonMin = LON0 - 0.2, latMin = LAT0 - 0.2;
  const hs = new Float32Array(aw * ah);
  const orography = new Float32Array(aw * ah);
  for (let j = 0; j < ah; j++) {
    for (let i = 0; i < aw; i++) {
      const lon = lonMin + i * 0.01, lat = latMin + j * 0.01;
      const o = oro((lon - LON0) * M_LON, (lat - LAT0) * M_LAT);
      orography[j * aw + i] = o;
      hs[j * aw + i] = aromeHs(lon, lat, o);
    }
  }
  const coarse: CoarseSnowGrid = { source: 'arome', width: aw, height: ah, lonMin, latMin, dLon: 0.01, dLat: 0.01, hsCm: hs, orographyM: orography, resolutionM: 1100 };
  return {
    dem: { data, width: n, height: n, sizeX: size, sizeY: size },
    geo: { corners, gridNorthBearingDeg: 0 },
    coarse,
    farDem: null,
    canopy: null,
    observations: [],
    bra: null,
    weather: null,
    analysisTimeMs: Date.parse('2026-02-01T06:00:00Z'),
    config: { ...DEFAULT_SNOW_ENGINE_CONFIG, maxResolution: n, ...config },
    ...extra,
  };
}

function stats(a: Float32Array) {
  let s = 0, mn = Infinity, mx = -Infinity, bad = 0;
  for (const v of a) { if (!Number.isFinite(v)) bad++; s += v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  return { mean: s / a.length, min: mn, max: mx, bad };
}

/** Weather history: cold storms then, optionally, a warm sunny fortnight. */
function weather(analysisMs: number, warmDays: number, windFrom = 270): WeatherHistory {
  const hours = 60 * 24;
  const start = analysisMs - (hours - 1) * 3_600_000;
  const t = new Float32Array(hours), p = new Float32Array(hours), sf = new Float32Array(hours), u = new Float32Array(hours), d = new Float32Array(hours);
  for (let h = 0; h < hours; h++) {
    const daysLeft = (hours - 1 - h) / 24;
    const hourUtc = new Date(start + h * 3_600_000).getUTCHours();
    const warm = daysLeft < warmDays;
    t[h] = (warm ? 6 : -6) + 5 * Math.cos((2 * Math.PI * (hourUtc - 13)) / 24);
    const storm = !warm && Math.floor(daysLeft) % 12 < 2;
    p[h] = storm ? 2 : 0;
    sf[h] = storm ? 2 : 0;
    u[h] = storm ? 16 : 3;
    d[h] = storm ? windFrom : 150;
  }
  return { startMs: start, elevationM: 2000, temperatureC: t, precipitationMm: p, snowfallCm: sf, windSpeedMs: u, windDirDeg: d };
}

export function runPhysicsChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail: string) => out.push({ name, pass, detail });

  // 1. Flat ground, uniform 100 cm → 100 cm everywhere, nothing invented.
  {
    const input = idealInput(() => 1800, 1200, 161, () => 100, () => 1800);
    const r = computeSnowDistribution(input);
    const s = stats(r.hsCm);
    add('Terrain plat + AROME uniforme → champ uniforme', s.bad === 0 && Math.abs(s.mean - 100) < 1.5 && s.max - s.min < 3,
      `moyenne ${s.mean.toFixed(1)} cm, min ${s.min.toFixed(1)}, max ${s.max.toFixed(1)}`);
  }

  // 2. Elevation downscaling: cells follow HS = 0.12·(z − 1200); a 1 km
  //    tilted plane from 1700 to 2300 m inside one cell at 2000 m.
  {
    const profile = (z: number) => Math.max(0, 0.12 * (z - 1200));
    const input = idealInput((x) => 2000 + 0.6 * x, 1000, 161, (_lon, _lat, o) => profile(o), (x, y) => 1500 + 0.02 * x + 0.015 * y + 600 * Math.sin(x / 4000) * Math.cos(y / 5000), {}, { maxWindRedistribution: 0, defaultWindRedistribution: 0, triggerSlopeDeg: 91 });
    const r = computeSnowDistribution(input);
    const w = r.width;
    const low = r.hsCm[80 * w + 2], high = r.hsCm[80 * w + w - 3];
    const zLow = 2000 + 0.6 * (2 * 1000 / 160 - 500), zHigh = 2000 + 0.6 * ((w - 3) * 1000 / 160 - 500);
    add('Descente d’échelle altitudinale (gradient 12 cm/100 m)', Math.abs(low - profile(zLow)) < 0.12 * profile(zLow) + 5 && Math.abs(high - profile(zHigh)) < 0.12 * profile(zHigh) + 5,
      `bas ${low.toFixed(0)} cm (attendu ${profile(zLow).toFixed(0)}) à ${zLow.toFixed(0)} m, haut ${high.toFixed(0)} cm (attendu ${profile(zHigh).toFixed(0)}) à ${zHigh.toFixed(0)} m`);
  }

  // 3. Holding depth curve.
  {
    const c = DEFAULT_SNOW_ENGINE_CONFIG;
    const h = [30, 40, 50, 60, 75].map((s) => holdingDepthCm(s, c) / 100);
    add('Hauteur de rétention SnowSlide (m) à 30/40/50/60/75°', Math.abs(h[0] - 3.54) < 0.05 && Math.abs(h[2] - 1.27) < 0.03 && Math.abs(h[3] - 0.88) < 0.03 && Math.abs(h[4] - 0.15) < 0.02 && holdingDepthCm(20, c) === Infinity,
      h.map((v) => v.toFixed(2)).join(' / '));
  }

  // 4. SnowSlide: a 50° couloir over a flat floor; mass kept, deposit at the foot.
  {
    const n = 121, cell = 2;
    const z = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - 60, y - 60) * cell;
      z[y * n + x] = 2000 + (d > 40 ? Math.min(60, d - 40) * Math.tan((50 * Math.PI) / 180) : 0);
    }
    const grid: WorkGrid = { width: n, height: n, dx: cell, dy: cell, ps: cell, sizeX: cell * (n - 1), sizeY: cell * (n - 1), z };
    const hs = new Float32Array(n * n).fill(200);
    const before = hs.reduce((a, v) => a + v, 0);
    const res = snowSlide(hs, grid, DEFAULT_SNOW_ENGINE_CONFIG);
    const after = hs.reduce((a, v) => a + v, 0);
    // Toe ring (19–23 cells = 38–46 m from the centre) and mid-wall (70 m).
    let foot = 0;
    for (let k = 19; k <= 23; k++) foot = Math.max(foot, hs[60 * n + 60 + k]);
    const wall = hs[60 * n + 60 + 35];
    add('SnowSlide : masse conservée, dépôt au pied, paroi délestée', Math.abs(after - before) / before < 1e-3 && foot > 300 && wall < 0.75 * 127,
      `pied ${foot.toFixed(0)} cm, paroi 50° ${wall.toFixed(0)} cm (rétention 127 cm), sortie ${(res.lost * 100).toFixed(1)} %`);
  }

  // 5. Wind: a N–S ridge, storms from the west → west flank and crest
  //    scoured, east (lee) flank loaded.
  {
    const ridge = (x: number) => 2200 + 150 * Math.exp(-((x / 180) ** 2));
    const t = Date.parse('2026-02-01T06:00:00Z');
    const input = idealInput((x) => ridge(x), 1400, 141, () => 120, () => 2250, { weather: weather(t, 0, 270), analysisTimeMs: t }, { triggerSlopeDeg: 91 });
    const r = computeSnowDistribution(input);
    const w = r.width;
    const row = 70;
    const at = (xm: number) => r.hsCm[row * w + Math.round((xm + 700) / 10)];
    const west = (at(-260) + at(-200)) / 2, crest = at(0), east = (at(130) + at(200)) / 2;
    add('Vent d’ouest : crête érodée, versant sous le vent chargé', east > west && east > crest && crest < 120,
      `versant ouest ${west.toFixed(0)} cm, crête ${crest.toFixed(0)} cm, versant est ${east.toFixed(0)} cm (rose ${r.diagnostics.wind.source})`);
  }

  // 6. Melt by exposure: E–W ridge after a warm sunny fortnight in April.
  {
    const t = Date.parse('2026-04-10T06:00:00Z');
    const input = idealInput((_x, y) => 2000 + 0.7 * Math.abs(y), 1000, 101, () => 120, () => 2200, { weather: weather(t, 14, 270), analysisTimeMs: t }, { maxWindRedistribution: 0, defaultWindRedistribution: 0, triggerSlopeDeg: 91 });
    const r = computeSnowDistribution(input);
    const w = r.width;
    // V valley along x: the northern half faces south, the southern half faces north.
    const facingSouth = r.hsCm[90 * w + 50], facingNorth = r.hsCm[10 * w + 50];
    add('Fonte différentielle : versant sud < versant nord', facingSouth < facingNorth - 10,
      `exposé nord ${facingNorth.toFixed(0)} cm, exposé sud ${facingSouth.toFixed(0)} cm, fonte à plat ${r.diagnostics.melt.flatMeltCm.toFixed(0)} cm`);
  }

  // 7. Forest: full canopy, mid-winter, no melt → −39.6 % of accumulation.
  {
    const input = idealInput(() => 1500, 800, 81, () => 100, () => 1500, { canopy: { data: new Float32Array(81 * 81).fill(1), width: 81, height: 81 } }, { maxWindRedistribution: 0, defaultWindRedistribution: 0 });
    const r = computeSnowDistribution(input);
    const s = stats(r.hsCm);
    add('Forêt dense, plein hiver : −40 % (Varhola 2010)', Math.abs(s.mean - 60.4) < 4, `moyenne ${s.mean.toFixed(1)} cm (attendu ≈ 60)`);
  }

  // 8. Assimilation: AROME 40 % low, 6 exact stations + 1 faulty → corrected,
  //    leave-one-out accurate, the faulty one rejected.
  {
    const truth = (z: number) => Math.max(0, 0.15 * (z - 1100));
    const obs: SnowObservation[] = [];
    const sites = [[-8000, 3000, 1500], [5000, -6000, 1800], [12000, 9000, 2100], [-15000, -4000, 2400], [3000, 14000, 1300], [-6000, -12000, 2000]];
    sites.forEach(([x, y, z], k) => obs.push({ id: `s${k}`, source: 'test', lon: LON0 + x / M_LON, lat: LAT0 + y / M_LAT, elevationM: z, hsCm: Math.round(truth(z)), kind: 'flat' }));
    obs.push({ id: 'faulty', source: 'test', lon: LON0 + 2000 / M_LON, lat: LAT0, elevationM: 1700, hsCm: 400, kind: 'flat' });
    const input = idealInput(() => 2000, 800, 81, (_lon, _lat, o) => 0.6 * truth(o), (x, y) => 1700 + 400 * Math.sin(x / 7000) * Math.cos(y / 6000), { observations: obs }, { maxWindRedistribution: 0, defaultWindRedistribution: 0 });
    const r = computeSnowDistribution(input);
    const s = stats(r.hsCm);
    const st = r.diagnostics.assimilation.stations;
    const loo = st.filter((d) => d.used).map((d) => Math.abs(d.looAnalysisCm - d.observedCm));
    const looRmse = Math.sqrt(loo.reduce((a, v) => a + v * v, 0) / Math.max(1, loo.length));
    const faulty = st.find((d) => d.id === 'faulty');
    add('Assimilation : AROME −40 % corrigé, station fautive rejetée', Math.abs(s.mean - truth(2000)) < 12 && looRmse < 15 && faulty?.used === false,
      `champ ${s.mean.toFixed(0)} cm (vrai ${truth(2000)}), LOO RMSE ${looRmse.toFixed(1)} cm, k = ${r.diagnostics.assimilation.precipitationFactor.toFixed(2)}, station fautive ${faulty?.used ? 'gardée' : 'rejetée'}`);
  }

  // 9. In-scene probe: the field passes through the measurement.
  {
    const probe: SnowObservation = { id: 'p', source: 'sonde', lon: LON0, lat: LAT0, elevationM: null, hsCm: 180, kind: 'point' };
    const input = idealInput(() => 1800, 600, 121, () => 100, () => 1800, { observations: [probe] }, { maxWindRedistribution: 0, defaultWindRedistribution: 0 });
    const r = computeSnowDistribution(input);
    const w = r.width;
    const centre = r.hsCm[60 * w + 60], far = r.hsCm[60 * w + 5];
    add('Sondage dans la scène : le champ passe par la mesure', Math.abs(centre - 180) < 8 && Math.abs(far - 100) < 5, `au sondage ${centre.toFixed(0)} cm (mesuré 180), à 275 m ${far.toFixed(0)} cm`);
  }

  // 10. No snow anywhere → zeros, fast.
  {
    const input = idealInput((x) => 1500 + 0.3 * x, 800, 81, () => 0, () => 1500);
    const t0 = performance.now();
    const r = computeSnowDistribution(input);
    const s = stats(r.hsCm);
    add('Pas de neige → champ nul', s.max === 0 && s.bad === 0, `max ${s.max} cm, ${(performance.now() - t0).toFixed(0)} ms`);
  }

  // 11. Determinism.
  {
    const t = Date.parse('2026-03-01T06:00:00Z');
    const mk = () => idealInput((x, y) => 2000 + 200 * Math.sin(x / 150) * Math.cos(y / 200), 600, 81, (_lon, _lat, o) => 0.1 * (o - 1000), (x) => 1900 + 0.01 * x, { weather: weather(t, 5), analysisTimeMs: t });
    const a = computeSnowDistribution(mk()).hsCm;
    const b = computeSnowDistribution(mk()).hsCm;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    add('Déterminisme (deux calculs identiques)', diff === 0, `écart max ${diff}`);
  }

  // 12. Sun position: Grenoble, 21 June, solar noon.
  {
    const p = sunPosition(Date.parse('2026-06-21T11:37:00Z'), 45.19, 5.72);
    add('Position du soleil (Grenoble, solstice, midi solaire)', Math.abs(p.azimuthDeg - 180) < 3 && Math.abs(p.elevationDeg - (90 - 45.19 + 23.44)) < 0.6,
      `azimut ${p.azimuthDeg.toFixed(1)}°, hauteur ${p.elevationDeg.toFixed(1)}° (attendu ${(90 - 45.19 + 23.44).toFixed(1)}°)`);
  }

  return out;
}

if (process.argv[1]?.endsWith('physics.ts')) {
  const res = runPhysicsChecks();
  for (const r of res) console.log(`${r.pass ? 'OK  ' : 'FAIL'} ${r.name} — ${r.detail}`);
  if (res.some((r) => !r.pass)) process.exitCode = 1;
}
