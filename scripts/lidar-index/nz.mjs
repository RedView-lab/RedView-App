// Index LiDAR Nouvelle-Zélande : nuages de points LINZ diffusés par OpenTopography.
//
// OpenTopography est la seule diffusion publique des nuages de points LINZ
// (les buckets AWS de LINZ — nz-elevation, nz-coastal… — ne contiennent que
// des MNT/MNS rasters). Bucket `pc-bulk` listable, CORS renvoyé pour
// l'origine appelante, LAZ (LAS 1.2–1.4) en NZTM2000.
//
// Les dalles suivent la grille Topo50 : feuille 24 × 36 km (« BW23 »)
// découpée en 1:500 (100×100, 240 × 360 m, `rrrccc`), 1:1000 (50×50,
// 480 × 720 m) ou 1:2000 (25×25, 960 × 1440 m), `rrcc` depuis le nord-ouest.
// Quelques jeux anciens ont une grille propre (Wellington 2013, Alpine 2015) :
// leur emprise vient de l'en-tête LAS de chaque fichier.
//
// Exclus : jeux trop peu denses (< NZ_MIN_DENSITY, campagnes 2010 de
// recherche sur failles à ~1 pt/m²), jeux hors NZTM2000 (NZ14_Dolan en
// UTM 59S), dossier de transit `NZ20_Cant2_Temp`, fichiers au-delà du budget
// de points du viewer.
import proj4 from 'proj4';
import { cachedListAll, cachedProbes, listDirs } from './s3.mjs';
import { traceCoverage } from './raster.mjs';
import { maskToHex, roundLonLat } from './encode.mjs';

export const OT_BUCKET = 'https://opentopography.s3.sdsc.edu/pc-bulk';
const BASE_URL = `${OT_BUCKET}/`;

/** Densité médiane minimale d'un jeu (pts/m²) : « que du LiDAR dense ». */
export const NZ_MIN_DENSITY = 2;
/** Même budget que le Japon : ~40 M points par fichier. */
export const NZ_MAX_POINTS = 40_000_000;
/** Dalles quasi vides (lacs, mer : LINZ publie des fichiers de quelques points) écartées. */
export const NZ_MIN_FILE_BYTES = 100_000;

const LEGACY_ROOTS = [
  'Amberley_2012/', 'Auckland_2013/', 'BOP_Coast_2015/', 'Chch_Selwn_2015/', 'Hurunui_2013/', 'Hurunui_2015/',
  'Kaikoura_2012/', 'Rangiora_2014/', 'Timaru_2014/', 'Waikato_2015/', 'Wellington_2013/',
];
const EXCLUDED_ROOTS = new Set(['NZ20_Cant2_Temp/']);

const ROW_LETTERS = [
  'AS', 'AT', 'AU', 'AV', 'AW', 'AX', 'AY', 'AZ',
  'BA', 'BB', 'BC', 'BD', 'BE', 'BF', 'BG', 'BH', 'BJ', 'BK', 'BL', 'BM', 'BN', 'BP', 'BQ', 'BR', 'BS', 'BT', 'BU', 'BV', 'BW', 'BX', 'BY', 'BZ',
  'CA', 'CB', 'CC', 'CD', 'CE', 'CF', 'CG', 'CH', 'CJ', 'CK', 'CL', 'CM', 'CN', 'CP', 'CQ', 'CR', 'CS', 'CT', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
];
const NORTH_ORIGIN = 6_234_000;
const WEST_ORIGIN = 988_000;
const SHEET_W = 24_000;
const SHEET_H = 36_000;
/** Tuiles par côté de feuille selon l'échelle. */
const PER_SHEET = { 500: 100, 1000: 50, 2000: 25 };

// ot_CL2_BV24_2012_1000_3930_1.laz, CL3_AY30_2016_1000_4050.laz, BJ34_1000_3734.laz, CL2_BP31_2021_500_012034.laz
const RE_TOPO = /^((?:ot_)?(?:CL\d_)?)([A-Z]{2}\d{2})(_(?:\d{4}_)?)(500|1000|2000)_(\d{4}|\d{6})((?:_\d)?\.la[sz])$/;
// ot_RPC_AZ31_1026_2013.laz (Auckland 2013, dalles 1:1000 sans échelle dans le nom)
const RE_RPC = /^(ot_RPC_)([A-Z]{2}\d{2})(_)(\d{4})(_\d{4}\.la[sz])$/;
// AF2015_C_BT22_15190_52980.laz : coin SO en hectomètres NZTM, dalles de 500 m
const RE_HECTO = /^AF\d{4}_[A-Z]_[A-Z]{2}\d{2}_(\d{5})_(\d{5})\.la[sz]$/;

function topoTileBounds(sheet, scale, rc) {
  const row = ROW_LETTERS.indexOf(sheet.slice(0, 2));
  const col = Number(sheet.slice(2));
  if (row < 0) return null;
  const n = PER_SHEET[scale];
  const half = rc.length / 2;
  const r = Number(rc.slice(0, half));
  const c = Number(rc.slice(half));
  if (r < 1 || c < 1 || r > n || c > n) return null;
  const w = SHEET_W / n;
  const h = SHEET_H / n;
  const minE = WEST_ORIGIN + col * SHEET_W + (c - 1) * w;
  const maxN = NORTH_ORIGIN - row * SHEET_H - (r - 1) * h;
  return { minE, minN: maxN - h, maxE: minE + w, maxN };
}

function parseName(name) {
  let m = name.match(RE_TOPO);
  if (m) {
    const scale = Number(m[4]);
    return { kind: 'topo', scale, sheet: m[2], rc: m[5], template: `${m[1]}{sheet}${m[3]}${m[4]}_{rc}${m[6]}`, bounds: topoTileBounds(m[2], scale, m[5]) };
  }
  m = name.match(RE_RPC);
  if (m) return { kind: 'topo', scale: 1000, sheet: m[2], rc: m[4], template: `${m[1]}{sheet}${m[3]}{rc}${m[5]}`, bounds: topoTileBounds(m[2], 1000, m[4]) };
  m = name.match(RE_HECTO);
  if (m) {
    const minE = Number(m[1]) * 100;
    const minN = Number(m[2]) * 100;
    return { kind: 'bbox', bounds: { minE, minN, maxE: minE + 500, maxN: minN + 500 } };
  }
  return { kind: 'bbox', bounds: null };
}

const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
};
const inNztm = (h) => h.minX > 1_000_000 && h.maxX < 2_300_000 && h.minY > 4_700_000 && h.maxY < 6_300_000;

function datasetYear(dir, files) {
  const legacy = dir.match(/_(\d{4})\//);
  if (legacy) return Number(legacy[1]);
  const m = dir.match(/^NZ(\d{2})_/);
  return m ? 2000 + Number(m[1]) : median(files.map(f => Number(f.name.match(/_(20\d\d)_/)?.[1])));
}

export async function buildNz({ refresh = false } = {}) {
  const roots = [...(await listDirs(OT_BUCKET, 'NZ')), ...LEGACY_ROOTS].filter(r => !EXCLUDED_ROOTS.has(r));
  const groups = new Map(); // dossier → fichiers
  for (const root of roots) {
    const rows = await cachedListAll(OT_BUCKET, root, { refresh });
    for (const [key, size] of rows) {
      if (!/\.la[sz]$/i.test(key)) continue;
      const slash = key.lastIndexOf('/');
      const dir = key.slice(0, slash + 1);
      const name = key.slice(slash + 1);
      let list = groups.get(dir);
      if (!list) { list = []; groups.set(dir, list); }
      list.push({ name, size, ...parseName(name) });
    }
  }

  // 1. Densité, octets/point et SCR : en-têtes d'un échantillon par dossier.
  const samples = new Map();
  for (const [dir, files] of groups) {
    const step = Math.max(1, Math.floor(files.length / 12));
    samples.set(dir, files.filter((_, i) => i % step === Math.floor(step / 2)).slice(0, 12).map(f => `${BASE_URL}${dir}${f.name}`));
  }
  const sampleHeaders = await cachedProbes([...samples.values()].flat(), { label: 'densité NZ' });

  const stats = [];
  const kept = [];
  for (const [dir, files] of groups) {
    const headers = samples.get(dir).map(u => [u, sampleHeaders[u]]).filter(([, h]) => h && h.count > 0);
    const sizeOf = new Map(files.map(f => [`${BASE_URL}${dir}${f.name}`, f.size]));
    // Densité sur les dalles pleines : les dalles de bord ne couvrent qu'une frange.
    const areas = headers.map(([, h]) => (h.maxX - h.minX) * (h.maxY - h.minY));
    const fullArea = Math.max(...areas, 0);
    const density = median(headers.filter((_, i) => areas[i] >= fullArea * 0.8).map(([, h]) => h.count / ((h.maxX - h.minX) * (h.maxY - h.minY))));
    const bytesPerPoint = median(headers.map(([u, h]) => sizeOf.get(u) / h.count));
    const nztm = headers.length > 0 && headers.every(([, h]) => inNztm(h));
    const year = datasetYear(dir, files);
    const stat = { dir, files: files.length, year, density: Math.round(density * 10) / 10, bytesPerPoint: Math.round(bytesPerPoint * 10) / 10, kept: 0, reason: '', note: '' };
    stats.push(stat);
    if (!nztm) { stat.reason = 'hors NZTM2000'; continue; }
    if (!(density >= NZ_MIN_DENSITY)) { stat.reason = `densité < ${NZ_MIN_DENSITY} pts/m²`; continue; }
    kept.push({ dir, files, year, density, bytesPerPoint, stat });
  }

  // 2. L'échelle écrite dans le nom n'est pas fiable (NZ16_Otago nomme « 2000 »
  //    des dalles de la grille 1:1000) : on la vérifie sur des en-têtes par
  //    gabarit ; sans grille cohérente, emprise lue fichier par fichier.
  const gridGroups = [];
  for (const d of kept) {
    const byTemplate = new Map();
    for (const f of d.files) {
      if (f.kind !== 'topo') continue;
      if (!byTemplate.has(f.template)) byTemplate.set(f.template, []);
      byTemplate.get(f.template).push(f);
    }
    for (const files of byTemplate.values()) {
      const step = Math.max(1, Math.floor(files.length / 6));
      const picks = files.filter((_, i) => i % step === 0).slice(0, 6);
      // + la dalle la plus au sud-est : c'est elle qui départage les grilles.
      const far = files.reduce((a, b) => (Number(b.rc) > Number(a.rc) ? b : a));
      if (!picks.includes(far)) picks.push(far);
      gridGroups.push({ d, files, picks });
    }
  }
  const gridHeaders = await cachedProbes(gridGroups.flatMap(g => g.picks.map(f => `${BASE_URL}${g.d.dir}${f.name}`)), { label: 'grilles NZ' });
  for (const { d, files, picks } of gridGroups) {
    const headers = picks.map(f => [f, gridHeaders[`${BASE_URL}${d.dir}${f.name}`]]).filter(([, h]) => h && h.count > 0);
    const fits = (scale) => headers.length > 0 && headers.every(([f, h]) => {
      const b = topoTileBounds(f.sheet, scale, f.rc);
      return b && h.minX >= b.minE - 10 && h.maxX <= b.maxE + 10 && h.minY >= b.minN - 10 && h.maxY <= b.maxN + 10;
    });
    const labelled = files[0].scale;
    const scale = [...new Set([labelled, 1000, 2000, 500])].find(fits);
    if (scale !== labelled) d.stat.note = scale ? `${files[0].template} : grille 1:${scale}` : `${files[0].template} : emprises lues par en-tête`;
    for (const f of files) {
      if (scale) {
        f.scale = scale;
        f.bounds = topoTileBounds(f.sheet, scale, f.rc);
      } else {
        f.kind = 'bbox';
        f.bounds = null;
      }
    }
  }

  // 3. Emprise des fichiers hors grille Topo50 : en-tête de chacun.
  const bboxUrls = kept.flatMap(d => d.files.filter(f => f.kind === 'bbox' && !f.bounds).map(f => `${BASE_URL}${d.dir}${f.name}`));
  const bboxHeaders = await cachedProbes(bboxUrls, { label: 'emprises NZ' });
  for (const d of kept) {
    for (const f of d.files) {
      if (f.kind !== 'bbox' || f.bounds) continue;
      const h = bboxHeaders[`${BASE_URL}${d.dir}${f.name}`];
      if (h && h.count > 0 && inNztm(h)) {
        f.bounds = { minE: Math.floor(h.minX), minN: Math.floor(h.minY), maxE: Math.ceil(h.maxX), maxN: Math.ceil(h.maxY) };
      }
    }
  }

  // 4. Index : un sous-ensemble par (dossier, gabarit de nom, échelle).
  kept.sort((a, b) => b.year - a.year || b.density - a.density);
  const datasets = [];
  const cover = new NzCoverageGrid();
  for (const d of kept) {
    const subsets = new Map();
    for (const f of d.files) {
      if (!f.bounds) continue;
      if (f.size / d.bytesPerPoint > NZ_MAX_POINTS || f.size < NZ_MIN_FILE_BYTES) continue;
      const k = f.kind === 'topo' ? `${f.scale}|${f.template}` : 'bbox';
      let s = subsets.get(k);
      if (!s) { s = { kind: f.kind, scale: f.scale, template: f.template, sheets: new Map(), tiles: [] }; subsets.set(k, s); }
      if (f.kind === 'topo') {
        const n = PER_SHEET[f.scale];
        let mask = s.sheets.get(f.sheet);
        if (!mask) { mask = new Uint8Array(n * n); s.sheets.set(f.sheet, mask); }
        const half = f.rc.length / 2;
        mask[(Number(f.rc.slice(0, half)) - 1) * n + Number(f.rc.slice(half)) - 1] = 1;
      } else {
        s.tiles.push(`${f.name}|${f.bounds.minE}|${f.bounds.minN}|${f.bounds.maxE}|${f.bounds.maxN}`);
      }
      cover.mark(f.bounds);
      d.stat.kept++;
    }
    for (const s of subsets.values()) {
      const common = { id: d.dir.replace(/\/$/, ''), year: d.year, density: Math.round(d.density * 10) / 10, base: `${BASE_URL}${d.dir}` };
      if (s.kind === 'topo') {
        const entries = [...s.sheets.entries()].sort(([a], [b]) => a.localeCompare(b));
        datasets.push({ ...common, scale: s.scale, name: s.template, sheets: entries.map(([sheet, mask]) => sheet + maskToHex(mask)).join('') });
      } else {
        datasets.push({ ...common, scale: 0, name: '', tiles: s.tiles.join(';') });
      }
    }
  }
  return { datasets, stats, coverage: cover.toGeoJson() };
}


/** Grille de couverture au pas 1:500 (240 × 360 m) calée sur l'origine Topo50. */
class NzCoverageGrid {
  constructor() {
    this.w = 60 * 100; // 60 colonnes de feuilles (E 988 → 2 428 km)
    this.h = ROW_LETTERS.length * 100;
    this.grid = new Uint8Array(this.w * this.h);
  }

  mark({ minE, minN, maxE, maxN }) {
    // Cellules dont le centre est dans l'emprise (exact pour les grilles Topo50).
    const c0 = Math.ceil((minE - WEST_ORIGIN) / 240 - 0.5);
    const c1 = Math.floor((maxE - WEST_ORIGIN) / 240 - 0.5);
    const r0 = Math.ceil((NORTH_ORIGIN - maxN) / 360 - 0.5);
    const r1 = Math.floor((NORTH_ORIGIN - minN) / 360 - 0.5);
    for (let r = Math.max(0, r0); r <= Math.min(this.h - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(this.w - 1, c1); c++) this.grid[r * this.w + c] = 1;
    }
  }

  toGeoJson() {
    const toWgs = proj4('+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs', 'EPSG:4326');
    const polygons = traceCoverage(this.grid, this.w, this.h).map(rings => rings.map(ring => {
      const coords = ring.map(([x, y]) => roundLonLat(toWgs.forward([WEST_ORIGIN + x * 240, NORTH_ORIGIN - y * 360])));
      coords.push(coords[0]);
      return coords.reverse();
    }));
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygons } }] };
  }
}
