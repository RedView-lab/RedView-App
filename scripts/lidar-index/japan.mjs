// Index LiDAR Japon : nuages de points aériens complets (toutes classes) et denses.
//
// Sources (accès anonyme, CORS `*`, un fichier par feuille du 公共測量標準図郭
// en JGD2011 plan rectangulaire) :
//   - S3 virtual-shizuoka : base de nuages de points de la préfecture de Shizuoka ;
//   - S3 japan-pointcloud : préfectures de Tokyo, Yamanashi, Saitama… ;
//   - S3 kanagawa-pointcloud : préfecture de Kanagawa, 2019 → 2024 ;
//   - base 3DDB de l'AIST (COPC) : Hyogo (préfecture entière), Nagasaki,
//     jumeau numérique de Tokyo.
//
// Exclus (vérifié sur échantillons d'en-têtes et de classes, 2026-10) :
//   - produits « Ground » filtrés sol seul (classe 2 uniquement) : 2021/LP,
//     2025/LP, ALB/Ground de Shizuoka, Shimane 2015/2017 (≈ 3 pts/m²), Kochi ;
//   - MNT/MNS dérivés (« 1m » de Hyogo, Grid, DEM, DSM) ;
//   - Shimane 2017 Original, Osaka : texte XYZ, pas du LAS ;
//   - Ishikawa 2024 (Noto) : 52 archives de 6 à 32 Go chacune, hors budget navigateur ;
//   - MMS / ULS / HYB / Backpack / UAV : levés routiers ou fluviaux en couloir ;
//   - GSI (payant), Hiroshima DoboX (compte requis), Gifu (CC BY-NC), Nagano
//     (géo-bloqué), gic-tokyo (doublon de Tokyo 2024).
// Les dossiers « Ground » 2019/2020/2022 de Shizuoka sont en réalité des
// nuages complets (classes 1/2 non filtrées, ou 1-6 classifiées) : inclus.
//
// Le découpage d'une feuille 1:5000 (3 km N-S × 4 km E-O) n'est pas le même
// partout et ne se lit pas dans le nom : niveau 500 (10×10, chiffres 0-9,
// 300 × 400 m), quarts de quarts (2 chiffres 1-4 : quart 1:2500 puis quart de
// ce quart, 750 × 1000 m : Shizuoka 2022, Kanagawa), quarts 1:2500 (1-4,
// 1,5 × 2 km). La grille est vérifiée sur des en-têtes LAS ; si les fichiers
// ne remplissent pas leur feuille (Saitama sabo : bandes le long des
// torrents), l'emprise réelle de chaque fichier est lue dans son en-tête.
import proj4 from 'proj4';
import { cachedListAll, cachedProbes } from './s3.mjs';
import { AIST_COPC_BASE, cachedAistRecords } from './aist.mjs';
import { traceCoverage } from './raster.mjs';
import { maskToHex, roundLonLat } from './encode.mjs';

const VS = 'https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/';
const JP = 'https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com/';
const KN = 'https://kanagawa-pointcloud.s3.ap-northeast-1.amazonaws.com/';

/** Ordre = priorité de téléchargement à emplacement égal (plus récent, puis COPC, d'abord). */
export const JAPAN_SOURCES = [
  { id: 'shizuoka-2025-lp', host: VS, root: '2025/LP/Original/', year: 2025, label: 'VIRTUAL SHIZUOKA 2025 LP' },
  { id: 'shizuoka-2025-alb', host: VS, root: '2025/ALB/Original/', year: 2025, label: 'VIRTUAL SHIZUOKA 2025 ALB' },
  { id: 'saitama-2025-sabo', host: JP, root: 'Saitama/2025/01/LP/Sabo/LAS/', year: 2025, label: 'Saitama 2025 LP (sabo)' },
  { id: 'kanagawa-2024', host: KN, root: '2024/01/LP/Original/LAZ/', year: 2024, label: 'Kanagawa 2024 LP' },
  { id: 'tokyo-dt-copc', aist: { title: '東京都デジタルツイン実現プロジェクト', group: '92' }, year: 2024, label: 'Tokyo jumeau numérique (AIST 3DDB)' },
  { id: 'tokyo-2024', host: JP, root: 'Tokyo/2024/01/LP/Original/LAS/', year: 2024, label: 'Tokyo 2024 LP' },
  { id: 'yamanashi-2024', host: JP, root: 'Yamanashi/2024/01/LP/Original/LAS/', year: 2024, label: 'Yamanashi 2024 LP' },
  { id: 'tokyo-2023', host: JP, root: 'Tokyo/2023/01/LP/Original/LAS/', year: 2023, label: 'Tokyo 2023 LP' },
  { id: 'shizuoka-2022-lp', host: VS, root: '2022/LP/Ground/', year: 2022, label: 'VIRTUAL SHIZUOKA 2022 LP' },
  { id: 'kanagawa-2022', host: KN, root: '2022/01/LP/Original/LAS/', year: 2022, label: 'Kanagawa 2022 LP' },
  { id: 'shizuoka-2021-lp', host: VS, root: '2021/LP/Original/', year: 2021, label: 'VIRTUAL SHIZUOKA 2021 LP' },
  { id: 'kanagawa-2021', host: KN, root: '2021/01/LP/Original/LAS/', year: 2021, label: 'Kanagawa 2021 LP' },
  { id: 'nagasaki-copc', aist: { title: 'オープンナガサキ3次元点群データ', group: '86' }, year: 2020, label: 'Open Nagasaki (AIST 3DDB)' },
  { id: 'shizuoka-2020-lp', host: VS, root: '2020/LP/Ground/', year: 2020, label: 'VIRTUAL SHIZUOKA 2020 LP' },
  { id: 'kanagawa-2020-2', host: KN, root: '2020/02/LP/Original/LAS/', year: 2020, label: 'Kanagawa 2020 LP (2)' },
  { id: 'kanagawa-2020-1', host: KN, root: '2020/01/LP/Original/LAS/', year: 2020, label: 'Kanagawa 2020 LP (1)' },
  { id: 'shizuoka-2019-lp', host: VS, root: '2019/LP/Ground/', year: 2019, label: 'VIRTUAL SHIZUOKA 2019 LP' },
  { id: 'kanagawa-2019', host: KN, root: '2019/01/LP/Original/LAS/', year: 2019, label: 'Kanagawa 2019 LP' },
  { id: 'hyogo-copc', aist: { title: '兵庫県高精度3次元点群データ', group: '80' }, year: 2018, label: 'Hyogo (AIST 3DDB)' },
];

/**
 * Budget navigateur par fichier. LAS zippé : archive + LAS décompressé (34 o/pt)
 * + nuage décodé coexistent, et l'entrée doit rester sous la limite de 2 Gio du
 * lecteur ZIP (`swiss/zipReader.ts`) : 40 M points (une dalle IGN dense en
 * compte ~35 M). LAZ / COPC, décodés directement : 60 M points.
 */
export const JAPAN_MAX_POINTS_ZIP = 40_000_000;
export const JAPAN_MAX_POINTS_LAZ = 60_000_000;
/** Fichiers quasi vides (liserés de bord, mer) écartés : < 100 Ko ou < 25 000 points. */
const MIN_FILE_BYTES = 100_000;
const MIN_FILE_POINTS = 25_000;

// Lignes A.. depuis X = +300 km vers le sud ; les îles d'Izu de Tokyo vont jusqu'à « U ».
const ROWS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const COLS = 'ABCDEFGH';
const GRID_NORTH_M = 300_000;
const GRID_WEST_M = -160_000;
// 09KC3164 (sous-feuille en 2 chiffres) ; 09JB683 (quart 1=NO 2=NE 3=SO 4=SE).
const RE_SUB2 = /^(\d{2})([A-Z])([A-H])(\d)(\d)(\d)(\d)$/i;
const RE_QUARTER = /^(\d{2})([A-Z])([A-H])(\d)(\d)([1-4])$/i;

/** Quart 1-4 (1 = NO, 2 = NE, 3 = SO, 4 = SE) → (ligne, colonne) 0/1. */
const quarter = (q) => [(q - 1) >> 1, (q - 1) & 1];

/** Découpages d'une feuille 1:5000 : n×n sous-feuilles, (r, c) depuis le nord-ouest. */
const GRIDS = {
  500: { n: 10, rc: (a, b) => [a, b] },
  1250: {
    n: 4,
    rc: (a, b) => {
      if (a < 1 || a > 4 || b < 1 || b > 4) return null;
      const [qr, qc] = quarter(a);
      const [sr, sc] = quarter(b);
      return [qr * 2 + sr, qc * 2 + sc];
    },
  },
  2500: { n: 2, rc: (q) => quarter(q) },
};

/** Densité médiane minimale d'un jeu (pts/m²), comme pour la Nouvelle-Zélande. */
export const JAPAN_MIN_DENSITY = 2;

function parseCode(code) {
  let m = code.match(RE_SUB2);
  if (m) return { zone: Number(m[1]), letters: `${m[2]}${m[3]}`.toUpperCase(), r5: Number(m[4]), c5: Number(m[5]), digits: [Number(m[6]), Number(m[7])], levels: [500, 1250] };
  m = code.match(RE_QUARTER);
  if (m) return { zone: Number(m[1]), letters: `${m[2]}${m[3]}`.toUpperCase(), r5: Number(m[4]), c5: Number(m[5]), digits: [Number(m[6])], levels: [2500] };
  return null;
}

/** Emprise (m, zone de la feuille) de la sous-feuille selon le découpage, ou null. */
function sheetBounds(info, level) {
  const grid = GRIDS[level];
  const rc = grid.rc(...info.digits);
  if (!rc) return null;
  const north = GRID_NORTH_M - (ROWS.indexOf(info.letters[0]) * 10 + info.r5) * 3000;
  const west = GRID_WEST_M + (COLS.indexOf(info.letters[1]) * 10 + info.c5) * 4000;
  const h = 3000 / grid.n;
  const w = 4000 / grid.n;
  const maxN = north - rc[0] * h;
  const minE = west + rc[1] * w;
  return { minE, minN: maxN - h, maxE: minE + w, maxN, bit: rc[0] * grid.n + rc[1] };
}

/**
 * L'en-tête est-il dans la feuille 1:5000 du code (± 50 m) ? Quelques fichiers
 * déclarent une emprise aberrante (minimum à 0, centaines de km) : le viewer
 * les placerait mal, ils sont écartés.
 */
function headerInSheet(h, info) {
  const north = GRID_NORTH_M - (ROWS.indexOf(info.letters[0]) * 10 + info.r5) * 3000;
  const west = GRID_WEST_M + (COLS.indexOf(info.letters[1]) * 10 + info.c5) * 4000;
  return h.minX >= west - 50 && h.maxX <= west + 4050 && h.minY >= north - 3050 && h.maxY <= north + 50;
}

// Dossier relatif → gabarit : « 08/ME/28/ » → « {z}/{L}/{s}/ ».
function dirTemplate(dir, info) {
  const t = `${String(info.zone).padStart(2, '0')}/${info.letters}/${info.r5}${info.c5}/`;
  return dir.toUpperCase() === t ? '{z}/{L}/{s}/' : dir;
}

const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
};
const area = (b) => (b.maxE - b.minE) * (b.maxN - b.minN);
const headerBounds = (h) => ({ minE: h.minX, minN: h.minY, maxE: h.maxX, maxN: h.maxY });

/** Fichiers d'une source : { rel, size?, info, ext }. */
async function listSource(src, refresh) {
  if (src.aist) {
    const records = await cachedAistRecords(src.aist.title, src.aist.group, { refresh });
    return records.map(r => ({ rel: r.file, size: undefined, info: parseCode(r.code), ext: '.laz', code: r.code }));
  }
  const rows = await cachedListAll(src.host, src.root, { refresh });
  return rows.map(([key, size]) => {
    const rel = key.slice(src.root.length);
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    const ext = base.match(/\.(zip|laz|las)$/i)?.[0].toLowerCase();
    const code = ext ? base.slice(0, -ext.length) : '';
    return { rel, size, info: ext ? parseCode(code) : null, ext, code };
  });
}

export async function buildJapan({ refresh = false } = {}) {
  // 1. Fichiers regroupés par (source, zone, gabarit de dossier, casse, forme du code, extension).
  const subsets = [];
  const stats = [];
  for (const src of JAPAN_SOURCES) {
    const stat = { id: src.id, files: 0, tooBig: 0, skipped: 0, density: 0, grid: '' };
    stats.push(stat);
    const groups = new Map();
    for (const f of await listSource(src, refresh)) {
      if (!f.info) { stat.skipped++; continue; }
      const slash = f.rel.lastIndexOf('/');
      const dir = src.aist ? '' : f.rel.slice(0, slash + 1);
      const lower = f.code !== f.code.toUpperCase();
      const tpl = src.aist ? '' : dirTemplate(dir, f.info);
      // `lower` s'applique au code et aux jetons du gabarit : leur casse doit concorder.
      if (tpl === '{z}/{L}/{s}/' && (dir !== dir.toUpperCase()) !== lower) { stat.skipped++; continue; }
      const k = `${f.info.zone}|${tpl}|${lower}|${f.info.levels.join()}|${f.ext}`;
      if (!groups.has(k)) groups.set(k, { src, stat, zone: f.info.zone, dir: tpl, lower, ext: f.ext, levels: f.info.levels, files: [] });
      groups.get(k).files.push(f);
    }
    subsets.push(...groups.values());
  }
  const urlOf = (sub, f) => (sub.src.aist ? AIST_COPC_BASE : sub.src.host + sub.src.root) + f.rel;

  // 2. En-têtes : tous les COPC de l'AIST (1 Kio chacun, pas de taille dans l'API),
  //    ~8 par sous-ensemble S3 dont la sous-feuille la plus au sud-est, qui
  //    départage 10×10 et 4×4.
  for (const sub of subsets) {
    if (sub.src.aist) { sub.picks = sub.files; continue; }
    const step = Math.max(1, Math.floor(sub.files.length / 7));
    sub.picks = sub.files.filter((_, i) => i % step === 0).slice(0, 7);
    const far = sub.files.reduce((a, b) => (b.info.digits.join('') > a.info.digits.join('') ? b : a));
    if (!sub.picks.includes(far)) sub.picks.push(far);
  }
  const headers = {
    ...await cachedProbes(subsets.filter(s => !s.src.aist).flatMap(sub => sub.picks.map(f => urlOf(sub, f))), { label: 'grilles Japon' }),
    ...await cachedProbes(subsets.filter(s => s.src.aist).flatMap(sub => sub.picks.map(f => urlOf(sub, f))), { label: 'COPC AIST', bytes: 1024, concurrency: 24 }),
  };
  for (const sub of subsets) {
    const probed = sub.picks.map(f => [f, headers[urlOf(sub, f)]]).filter(([f, h]) => h && h.count > 0 && headerInSheet(h, f.info));
    // Échantillon S3 : toutes les sous-feuilles doivent tomber juste ; COPC de
    // l'AIST (tous lus) : 95 %.
    const quorum = sub.src.aist ? 0.95 : 1;
    const fits = (level) => probed.length > 0 && probed.filter(([f, h]) => {
      const b = sheetBounds(f.info, level);
      return b && h.minX >= b.minE - 10 && h.maxX <= b.maxE + 10 && h.minY >= b.minN - 10 && h.maxY <= b.maxN + 10;
    }).length >= quorum * probed.length;
    sub.level = sub.levels.find(fits) ?? 0;
    if (sub.level) {
      // Feuilles souvent partielles : la grille surestimerait la couverture.
      const partial = probed.filter(([f, h]) => area(headerBounds(h)) < 0.5 * area(sheetBounds(f.info, sub.level))).length;
      if (partial >= probed.length / 4) sub.level = 0;
      // Quarts 1:2500 (3 km², peu nombreux) : emprise réelle de chaque fichier.
      if (sub.level === 2500) sub.level = 0;
    }
    // Densité sur les fichiers pleins ; octets/point pour convertir la taille d'archive.
    const areas = probed.map(([, h]) => area(headerBounds(h)));
    const full = [...areas].sort((a, b) => a - b)[Math.floor(areas.length * 0.9)] ?? 0;
    sub.density = median(probed.filter((_, i) => areas[i] >= full * 0.8).map(([, h]) => h.count / area(headerBounds(h))));
    sub.bytesPerPoint = median(probed.map(([f, h]) => f.size / h.count));
    sub.maxPoints = sub.ext === '.zip' ? JAPAN_MAX_POINTS_ZIP : JAPAN_MAX_POINTS_LAZ;
    sub.stat.grid = [...new Set([...sub.stat.grid.split(' ').filter(Boolean), sub.src.aist ? 'COPC' : sub.level ? `1:${sub.level}` : 'emprises'])].join(' ');
    sub.stat.density = Math.round(sub.density);
    if (!(sub.density >= JAPAN_MIN_DENSITY)) sub.excluded = true;
  }

  // 3. Emprise réelle de chaque fichier S3 des sous-ensembles sans grille fiable.
  const exact = subsets.filter(sub => !sub.level && !sub.src.aist && !sub.excluded);
  Object.assign(headers, await cachedProbes(exact.flatMap(sub => sub.files.map(f => urlOf(sub, f))), { label: 'emprises Japon' }));

  // 4. Index et couverture (grille de base 150 × 200 m, sous-multiple de tous les découpages).
  const coverage = new Map();
  const mark = (zone, b) => {
    let grid = coverage.get(zone);
    if (!grid) { grid = new Uint8Array(COVER_ROWS * COVER_COLS); coverage.set(zone, grid); }
    const c0 = Math.ceil((b.minE - GRID_WEST_M) / 200 - 0.5);
    const c1 = Math.floor((b.maxE - GRID_WEST_M) / 200 - 0.5);
    const r0 = Math.ceil((GRID_NORTH_M - b.maxN) / 150 - 0.5);
    const r1 = Math.floor((GRID_NORTH_M - b.minN) / 150 - 0.5);
    for (let r = Math.max(0, r0); r <= Math.min(COVER_ROWS - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(COVER_COLS - 1, c1); c++) grid[r * COVER_COLS + c] = 1;
    }
  };
  const datasets = [];
  for (const sub of subsets) {
    if (sub.excluded) { sub.stat.grid += ` (< ${JAPAN_MIN_DENSITY} pts/m²)`; continue; }
    const { src } = sub;
    const base = src.aist ? AIST_COPC_BASE : src.host + src.root;
    const meta = { id: src.id, label: src.label, year: src.year, density: Math.round(sub.density), zone: sub.zone, level: sub.level, base, dir: sub.dir, ext: sub.ext, lower: sub.lower };
    const sheets = new Map();
    const tiles = [];
    for (const f of sub.files) {
      const h = headers[urlOf(sub, f)];
      if (h && h.count > 0 && !headerInSheet(h, f.info)) { sub.stat.skipped++; continue; }
      const points = h ? h.count : f.size / sub.bytesPerPoint;
      if (points > sub.maxPoints) { sub.stat.tooBig++; continue; }
      if (f.size < MIN_FILE_BYTES || points < MIN_FILE_POINTS) { sub.stat.skipped++; continue; }
      if (sub.level && !src.aist) {
        const b = sheetBounds(f.info, sub.level);
        if (!b) { sub.stat.skipped++; continue; }
        const key = `${f.info.letters}${f.info.r5}${f.info.c5}`;
        if (!sheets.has(key)) sheets.set(key, new Uint8Array(GRIDS[sub.level].n ** 2));
        sheets.get(key)[b.bit] = 1;
        mark(sub.zone, b);
      } else {
        // COPC de l'AIST (noms numériques) ou feuilles partielles : emprise par fichier,
        // celle de la feuille si la grille est vérifiée, sinon celle de l'en-tête.
        const sheet = sub.level ? sheetBounds(f.info, sub.level) : null;
        const b = sheet ?? (h && h.count > 0 ? headerBounds(h) : null);
        if (!b) { sub.stat.skipped++; continue; }
        const r = { minE: Math.floor(b.minE), minN: Math.floor(b.minN), maxE: Math.ceil(b.maxE), maxN: Math.ceil(b.maxN) };
        tiles.push(`${f.rel}|${r.minE}|${r.minN}|${r.maxE}|${r.maxN}`);
        mark(sub.zone, r);
      }
      sub.stat.files++;
    }
    if (sheets.size) {
      const entries = [...sheets.entries()].sort(([a], [b]) => a.localeCompare(b));
      datasets.push({ ...meta, sheets: entries.map(([k, mask]) => k + maskToHex(mask)).join('') });
    } else if (tiles.length) {
      datasets.push({ ...meta, level: 0, dir: '', lower: false, tiles: tiles.join(';') });
    }
  }
  return { datasets, stats, coverage: japanCoverageGeoJson(coverage) };
}

const COVER_ROWS = (ROWS.length * 30_000) / 150;
const COVER_COLS = (COLS.length * 40_000) / 200;

const ZONE_ORIGINS = {
  1: [33, 129.5], 2: [33, 131], 3: [36, 132.166666666667], 4: [33, 133.5], 5: [36, 134.333333333333],
  6: [36, 136], 7: [36, 137.166666666667], 8: [36, 138.5], 9: [36, 139.833333333333], 10: [40, 140.833333333333],
  11: [44, 140.25], 12: [44, 142.25], 13: [44, 144.25], 14: [26, 142], 15: [26, 127.5], 16: [26, 124],
  17: [26, 131], 18: [20, 136], 19: [26, 154],
};

function japanCoverageGeoJson(coverage) {
  const features = [];
  for (const [zone, grid] of [...coverage.entries()].sort(([a], [b]) => a - b)) {
    const [lat0, lon0] = ZONE_ORIGINS[zone];
    const toWgs = proj4(`+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`, 'EPSG:4326');
    const polygons = traceCoverage(grid, COVER_COLS, COVER_ROWS).map(rings => rings.map(ring => {
      const coords = ring.map(([x, y]) => roundLonLat(toWgs.forward([GRID_WEST_M + x * 200, GRID_NORTH_M - y * 150])));
      coords.push(coords[0]);
      return coords.reverse(); // y vers le bas → nord en haut : on rétablit l'extérieur anti-horaire (RFC 7946)
    }));
    features.push({ type: 'Feature', properties: { zone }, geometry: { type: 'MultiPolygon', coordinates: polygons } });
  }
  return { type: 'FeatureCollection', features };
}
