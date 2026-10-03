import type { NzLidarDataset, NzTileCoord } from './types';
import { getNzTileBounds, nzTileKey } from './coordConvert';
import { NZ_LIDAR_DATASETS } from './nzLazIndex';
import {
  boundsIntersect,
  bucketTileBounds,
  findTileBoundsAt,
  hasMaskBit,
  parseBoundedTiles,
  rankFootprintCandidates,
  rankTileCandidates,
  type TileBounds,
  type TileCandidate,
} from '../tileCandidates';

/**
 * Résolution des nuages de points LiDAR néo-zélandais (LINZ, diffusés par
 * OpenTopography) d'une dalle de 1 km NZTM2000, à partir de l'index généré
 * `nzLazIndex`.
 *
 * Les fichiers suivent la grille Topo50 : feuille 24 × 36 km (« BW23 »)
 * découpée en 1:500 (240 × 360 m), 1:1000 (480 × 720 m) ou 1:2000
 * (960 × 1440 m) ; quelques jeux anciens ont une grille propre (emprises
 * stockées).
 */

const ROW_LETTERS = [
  'AS', 'AT', 'AU', 'AV', 'AW', 'AX', 'AY', 'AZ',
  'BA', 'BB', 'BC', 'BD', 'BE', 'BF', 'BG', 'BH', 'BJ', 'BK', 'BL', 'BM', 'BN', 'BP', 'BQ', 'BR', 'BS', 'BT', 'BU', 'BV', 'BW', 'BX', 'BY', 'BZ',
  'CA', 'CB', 'CC', 'CD', 'CE', 'CF', 'CG', 'CH', 'CJ', 'CK', 'CL', 'CM', 'CN', 'CP', 'CQ', 'CR', 'CS', 'CT', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
];
const NORTH_ORIGIN = 6_234_000;
const WEST_ORIGIN = 988_000;
const SHEET_W = 24_000;
const SHEET_H = 36_000;
const PER_SHEET: Record<number, number> = { 500: 100, 1000: 50, 2000: 25 };

interface IndexedDataset {
  dataset: NzLidarDataset;
  rank: number;
  /** Feuille Topo50 → masque hex de ses dalles. */
  masks: Map<string, string>;
  tiles: { name: string; bounds: TileBounds }[];
  /** Index spatial de `tiles`, construit à la première recherche sous un point. */
  buckets?: Map<string, number[]>;
}

let indexed: IndexedDataset[] | null = null;

function getIndexedDatasets(): IndexedDataset[] {
  if (indexed) return indexed;
  indexed = NZ_LIDAR_DATASETS.map((dataset, rank) => {
    const masks = new Map<string, string>();
    if (dataset.scale && dataset.sheets) {
      const n = PER_SHEET[dataset.scale]!;
      const entryLength = 4 + Math.ceil((n * n) / 4);
      for (let i = 0; i + entryLength <= dataset.sheets.length; i += entryLength) {
        masks.set(dataset.sheets.slice(i, i + 4), dataset.sheets.slice(i + 4, i + entryLength));
      }
    }
    return { dataset, rank, masks, tiles: parseBoundedTiles(dataset.tiles) };
  });
  return indexed;
}

/** Fichier de la cellule (ligne, colonne) de la grille Topo50 du jeu, null s'il n'est pas publié. */
function topoCell(entry: IndexedDataset, row: number, col: number): TileCandidate | null {
  const { dataset } = entry;
  const n = PER_SHEET[dataset.scale]!;
  if (row < 0 || col < 0) return null;
  const letters = ROW_LETTERS[Math.floor(row / n)];
  if (!letters) return null;
  const sheet = `${letters}${String(Math.floor(col / n)).padStart(2, '0')}`;
  const mask = entry.masks.get(sheet);
  if (!mask) return null;
  const r = row % n;
  const c = col % n;
  if (!hasMaskBit(mask, r * n + c)) return null;
  const digits = n === 100 ? 3 : 2;
  const rc = `${String(r + 1).padStart(digits, '0')}${String(c + 1).padStart(digits, '0')}`;
  const w = SHEET_W / n;
  const h = SHEET_H / n;
  const minE = WEST_ORIGIN + col * w;
  const maxN = NORTH_ORIGIN - row * h;
  return {
    url: `${dataset.base}${dataset.name.replace('{sheet}', sheet).replace('{rc}', rc)}`,
    bounds: { minE, minN: maxN - h, maxE: minE + w, maxN },
    rank: entry.rank,
  };
}

function topoCandidates(entry: IndexedDataset, tile: TileBounds, out: TileCandidate[]): void {
  const n = PER_SHEET[entry.dataset.scale]!;
  const w = SHEET_W / n;
  const h = SHEET_H / n;
  const col0 = Math.floor((tile.minE - WEST_ORIGIN) / w);
  const col1 = Math.ceil((tile.maxE - WEST_ORIGIN) / w) - 1;
  const row0 = Math.floor((NORTH_ORIGIN - tile.maxN) / h);
  const row1 = Math.ceil((NORTH_ORIGIN - tile.minN) / h) - 1;
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const candidate = topoCell(entry, row, col);
      if (candidate) out.push(candidate);
    }
  }
}

/**
 * Emprise (NZTM2000, m) du fichier qui sert le point : jeu prioritaire d'abord,
 * comme au téléchargement. Null hors couverture.
 */
export function findNzFileFootprintAt(east: number, north: number): TileBounds | null {
  for (const entry of getIndexedDatasets()) {
    if (entry.dataset.scale) {
      const n = PER_SHEET[entry.dataset.scale]!;
      const row = Math.floor((NORTH_ORIGIN - north) / (SHEET_H / n));
      const col = Math.floor((east - WEST_ORIGIN) / (SHEET_W / n));
      const cell = topoCell(entry, row, col);
      if (cell) return cell.bounds;
      continue;
    }
    entry.buckets ??= bucketTileBounds(entry.tiles);
    const bounds = findTileBoundsAt(entry.tiles, entry.buckets, east, north);
    if (bounds) return bounds;
  }
  return null;
}

const itemCache = new Map<string, string[]>();

/**
 * Fichiers candidats d'une dalle, du plus pertinent au moins pertinent : ceux
 * de l'emprise `footprint` pour une dalle-fichier, sinon ceux de la dalle de 1 km.
 */
export async function resolveNzDownloadUrls(coord: NzTileCoord, footprint?: TileBounds): Promise<string[]> {
  const key = footprint
    ? `${footprint.minE},${footprint.minN},${footprint.maxE},${footprint.maxN}`
    : nzTileKey(coord);
  const cached = itemCache.get(key);
  if (cached) return cached;

  const tile = footprint ?? getNzTileBounds(coord);
  const candidates: TileCandidate[] = [];
  for (const entry of getIndexedDatasets()) {
    if (entry.dataset.scale) {
      topoCandidates(entry, tile, candidates);
      continue;
    }
    for (const { name, bounds } of entry.tiles) {
      if (boundsIntersect(bounds, tile)) candidates.push({ url: `${entry.dataset.base}${name}`, bounds, rank: entry.rank });
    }
  }

  const urls = footprint ? rankFootprintCandidates(candidates, footprint) : rankTileCandidates(candidates, tile);
  itemCache.set(key, urls);
  return urls;
}
