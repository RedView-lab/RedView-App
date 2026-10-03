// Index LiDAR Pays-Bas : AHN (Actueel Hoogtebestand Nederland) découpé par
// GeoTiles (TU Delft, geotiles.citg.tudelft.nl).
//
// L'AHN officiel (basisdata.nl → stockage objet Hetzner) n'est publié que par
// feuille de 5 × 6,25 km (1,5 Gio) ; GeoTiles redécoupe chaque feuille en 25
// sous-dalles de 1 × 1,25 km (`65AN2_01` … `_25`, ligne par ligne depuis le
// nord-ouest), LAZ 1.4 PDRF 8 colorisé par l'orthophoto (RVB + PIR), RD New +
// NAP, avec une marge de 20 m autour de la sous-dalle. Aucune des deux
// sources n'envoie d'en-têtes CORS : le navigateur passe par `/api/pointcloud`.
//
// Les noms des feuilles (« 65AN2 ») ne suivent pas une formule : leur position
// vient de l'index des feuilles de fwrite.org (GeoPackage, table `AHN` :
// colonne `GT_AHN`, coin sud-ouest `left`/`bottom` en RD). Les sous-dalles
// présentes viennent des pages de feuille de GeoTiles (une par feuille).
//
// Jeux retenus, du prioritaire au repli : AHN5 (2023–2025, en cours), AHN4
// (2020–2022, national). AHN3 et antérieurs : moins denses, écartés.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import proj4 from 'proj4';
import { CACHE_DIR } from './s3.mjs';
import { squareGridCoverage } from './raster.mjs';
import { maskToHex, roundLonLat } from './encode.mjs';

export const GEOTILES = 'https://geotiles.citg.tudelft.nl';
const SHEET_INDEX_ZIP = 'https://static.fwrite.org/2022/01/index_sheets.gpkg_.zip';
const RD_NEW = '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs';

/** Feuille AHN 5 × 6,25 km, sous-dalle 1 × 1,25 km (5 × 5 par feuille). */
const SHEET_W = 5_000;
const SHEET_H = 6_250;
const SUB_W = 1_000;
const SUB_H = 1_250;

/** Sous-dalles quasi vides (mer, frontière : quelques milliers de points) écartées. */
export const AHN_MIN_FILE_BYTES = 300_000;
/**
 * Plafond de téléchargement (~100 M points à ~10 o/point en LAZ PDRF 8 ; p99
 * ≈ 800 Mio) : au-delà, la sous-dalle est écartée du jeu et le jeu suivant
 * (AHN4) la sert. Le viewer éclaircit uniformément les sous-dalles au-delà de
 * son budget de points (`lazParser.ts`, `LAS_POINT_BUDGET`).
 */
export const AHN_MAX_FILE_BYTES = 1024 * 1024 * 1024;

const DATASETS = [
  { id: 'AHN5', years: '2023–2025', dir: 'AHN5_T' },
  { id: 'AHN4', years: '2020–2022', dir: 'AHN4_T' },
];

async function fetchWithRetry(url, as) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (res.status === 404) return null;
      if (res.ok) return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch { /* réessai */ }
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw new Error(`GeoTiles : échec ${url}`);
}

/** Première entrée d'une archive ZIP (répertoire central : tailles fiables même avec descripteur de données). */
function unzipFirstEntry(zip) {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('ZIP sans répertoire central');
  const central = zip.readUInt32LE(eocd + 16);
  const method = zip.readUInt16LE(central + 10);
  const compressedSize = zip.readUInt32LE(central + 20);
  const local = zip.readUInt32LE(central + 42);
  const data = zip.subarray(local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28));
  const body = data.subarray(0, compressedSize);
  return method === 0 ? body : zlib.inflateRawSync(body);
}

/** Feuille AHN → coin sud-ouest RD, depuis le GeoPackage de fwrite.org (en cache). */
async function cachedSheetGrid({ refresh }) {
  const file = path.join(CACHE_DIR, 'ahn-sheet-grid.json');
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const zip = await fetchWithRetry(SHEET_INDEX_ZIP, 'buffer');
  const gpkg = path.join(CACHE_DIR, 'ahn-index-sheets.gpkg');
  fs.writeFileSync(gpkg, unzipFirstEntry(zip));
  const db = new DatabaseSync(gpkg, { readOnly: true });
  const grid = {};
  for (const row of db.prepare("SELECT GT_AHN AS name, left, bottom FROM AHN WHERE GT_AHN IS NOT NULL AND GT_AHN != ''").all()) {
    grid[row.name] = [row.left, row.bottom];
  }
  db.close();
  fs.rmSync(gpkg);
  fs.writeFileSync(file, JSON.stringify(grid));
  return grid;
}

const UNIT = { B: 1, kiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const RE_SUBTILE = /<tbody id="st_(\w{5})_(\d\d)">([\s\S]*?)<\/tbody>/g;
const RE_FILE = /<a href="\/(AHN\d)_T\/[^"]+\.LAZ">[^<]*<\/a>\s*<\/td>\s*<td>([\d.]+) (B|kiB|MiB|GiB)<\/td>/g;

/** Sous-dalles publiées par feuille et par jeu (taille en octets), depuis les pages GeoTiles. */
async function cachedSubtiles(sheets, { refresh }) {
  const file = path.join(CACHE_DIR, 'geotiles-subtiles.json');
  const cache = !refresh && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const todo = sheets.filter(name => !(name in cache));
  let done = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const name = todo[cursor++];
      const html = await fetchWithRetry(`${GEOTILES}/tiles/html/${name}.html`, 'text');
      const entry = {};
      for (const [, , sub, body] of html ? html.matchAll(RE_SUBTILE) : []) {
        for (const [, dataset, size, unit] of body.matchAll(RE_FILE)) {
          (entry[dataset] ??= {})[sub] = Math.round(Number(size) * UNIT[unit]);
        }
      }
      cache[name] = entry;
      if (++done % 100 === 0) {
        console.log(`  GeoTiles : ${done}/${todo.length} feuilles`);
        fs.writeFileSync(file, JSON.stringify(cache));
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (todo.length) fs.writeFileSync(file, JSON.stringify(cache));
  return cache;
}

export async function buildNetherlands({ refresh = false } = {}) {
  const grid = await cachedSheetGrid({ refresh });
  const index = await fetchWithRetry(`${GEOTILES}/index.tile.html`, 'text');
  const sheets = [...new Set([...index.matchAll(/tiles\/html\/(\w{5})\.html/g)].map(m => m[1]))].sort();
  const subtiles = await cachedSubtiles(sheets, { refresh });

  const stats = [];
  const cells = new Map();
  const datasets = [];
  const unplaced = sheets.filter(name => !grid[name]);
  for (const ds of DATASETS) {
    let files = 0;
    let bytes = 0;
    let tooSmall = 0;
    let tooBig = 0;
    let out = '';
    for (const name of sheets) {
      const sizes = subtiles[name]?.[ds.id];
      const origin = grid[name];
      if (!sizes || !origin) continue;
      const mask = new Array(25).fill(0);
      for (const [sub, size] of Object.entries(sizes)) {
        if (size < AHN_MIN_FILE_BYTES) { tooSmall++; continue; }
        if (size > AHN_MAX_FILE_BYTES) { tooBig++; continue; }
        const n = Number(sub) - 1;
        mask[n] = 1;
        files++;
        bytes += size;
        const col = origin[0] / SUB_W + (n % 5);
        const row = origin[1] / SUB_H + 4 - Math.floor(n / 5);
        cells.set(`${col},${row}`, [col, row]);
      }
      if (mask.some(Boolean)) out += `${name}${maskToHex(mask)}`;
    }
    stats.push({ dataset: ds.id, files, gio: +(bytes / 1024 ** 3).toFixed(0), tooSmall, tooBig });
    datasets.push({ id: ds.id, years: ds.years, base: `${GEOTILES}/${ds.dir}/`, sheets: out });
  }

  // Feuille → coin sud-ouest, en unités de feuille (5 km, 6,25 km).
  let sheetGrid = '';
  for (const name of sheets) {
    const origin = grid[name];
    if (!origin || !datasets.some(d => d.sheets.includes(name))) continue;
    sheetGrid += `${name}${String(origin[0] / SHEET_W).padStart(2, '0')}${String(origin[1] / SHEET_H).padStart(3, '0')}`;
  }

  const toLonLat = proj4(RD_NEW, 'EPSG:4326').forward;
  const polygons = squareGridCoverage(cells.values(), SUB_W, toLonLat, roundLonLat, SUB_H);
  return {
    stats,
    unplaced,
    sheetGrid,
    datasets,
    coverage: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygons } }] },
  };
}
