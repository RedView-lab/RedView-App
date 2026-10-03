// Index LiDAR Flandre (Belgique) : DHMV II (Digitaal Hoogtemodel Vlaanderen
// II, Digitaal Vlaanderen, vols 2013–2015), via EODaS OpenLidar.
//
// Les nuages de points ne sont pas publiés par dalle mais par morceau de bande
// de vol : chaque bande (≥ 8 pts/m², recouvrement latéral ≥ 50 %) est coupée
// sur une grille de 500 m en Lambert 72 (EPSG:31370, altitudes TAW/DNG),
// `…_<X>_<Y>.laz` = coin sud-ouest de la cellule. Une cellule réunit donc 2 à
// 10 morceaux de bandes qui se recouvrent (~16–25 pts/m² une fois fusionnés).
// La liste des morceaux d'une cellule est demandée au WFS au moment du clic
// (`flanders/dhmvClient.ts`, ~515 000 morceaux : trop pour l'index) ; l'index
// ne garde que le masque des cellules couvertes, qui sert au survol et à
// l'overlay vert.
//
// Le WFS renvoie CORS ; les fichiers (`/download/openlidar/…`) non : le
// navigateur les télécharge par `/api/pointcloud`.
import fs from 'node:fs';
import path from 'node:path';
import proj4 from 'proj4';
import { CACHE_DIR } from './s3.mjs';
import { squareGridCoverage } from './raster.mjs';
import { maskToHex, roundLonLat } from './encode.mjs';

const WFS = 'https://remotesensing.vlaanderen.be/services/openlidar/wfs';
const LAYER = 'openlidar:LiDAR_DHMV_II_LAZtiles';
const PAGE = 5_000;
export const DHMV_CELL_M = 500;
const BL72 = '+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs';
/** Cellules de bord (quelques points d'une bande qui déborde) écartées. */
export const DHMV_MIN_CELL_POINTS = 100_000;
const RE_CELL = /_(\d+)_(\d+)\.laz$/i;

async function fetchJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.ok) return await res.json();
    } catch { /* réessai */ }
    await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error(`WFS OpenLidar : échec ${url}`);
}

/** Cellule « X_Y » → [morceaux de bandes, points], en cache. */
async function cachedCells({ refresh }) {
  const file = path.join(CACHE_DIR, 'dhmv2-cells.json');
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const cells = {};
  const years = {};
  for (let start = 0; ; start += PAGE) {
    const url = `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${LAYER}&outputFormat=application/json`
      + `&propertyName=tile_location,tile_totalpoints,tile_year&sortBy=tile_id&count=${PAGE}&startIndex=${start}`;
    const page = await fetchJson(url);
    for (const { properties: p } of page.features ?? []) {
      const m = RE_CELL.exec(p.tile_location ?? '');
      if (!m) continue;
      const key = `${m[1]}_${m[2]}`;
      const cell = (cells[key] ??= [0, 0]);
      cell[0] += 1;
      cell[1] += p.tile_totalpoints ?? 0;
      years[p.tile_year] = (years[p.tile_year] ?? 0) + 1;
    }
    if ((start / PAGE) % 10 === 0) console.log(`  WFS OpenLidar : ${start + (page.features?.length ?? 0)} morceaux`);
    if ((page.features?.length ?? 0) < PAGE) break;
  }
  const out = { cells, years };
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

export async function buildFlanders({ refresh = false } = {}) {
  const { cells, years } = await cachedCells({ refresh });
  const kept = [];
  let strips = 0;
  let points = 0;
  let maxPoints = 0;
  let small = 0;
  for (const [key, [count, total]] of Object.entries(cells)) {
    if (total < DHMV_MIN_CELL_POINTS) { small++; continue; }
    const [x, y] = key.split('_').map(Number);
    kept.push([x / DHMV_CELL_M, y / DHMV_CELL_M]);
    strips += count;
    points += total;
    maxPoints = Math.max(maxPoints, total);
  }
  let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
  for (const [c, r] of kept) {
    minCol = Math.min(minCol, c); maxCol = Math.max(maxCol, c);
    minRow = Math.min(minRow, r); maxRow = Math.max(maxRow, r);
  }
  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;
  const mask = new Array(cols * rows).fill(0);
  for (const [c, r] of kept) mask[(r - minRow) * cols + (c - minCol)] = 1;

  const toLonLat = proj4(BL72, 'EPSG:4326').forward;
  const polygons = squareGridCoverage(kept, DHMV_CELL_M, toLonLat, roundLonLat);
  return {
    stats: [{
      cells: kept.length,
      smallCells: small,
      strips,
      pointsG: +(points / 1e9).toFixed(1),
      meanPtsPerM2: +(points / kept.length / (DHMV_CELL_M * DHMV_CELL_M)).toFixed(1),
      maxCellMpts: +(maxPoints / 1e6).toFixed(1),
      years: Object.entries(years).map(([y, n]) => `${y}:${n}`).join(' '),
    }],
    grid: { minCol, minRow, cols, rows, mask: maskToHex(mask) },
    coverage: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygons } }] },
  };
}
