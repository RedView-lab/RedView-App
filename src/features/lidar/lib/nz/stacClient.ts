import type { NzLidarDataset, NzTileCoord } from './types';
import { getNzTileBounds, nzTileKey } from './coordConvert';
import { NZ_LIDAR_DATASETS } from './nzLazIndex';
import {
  boundsIntersect,
  hasMaskBit,
  parseBoundedTiles,
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

function topoCandidates(entry: IndexedDataset, tile: TileBounds, out: TileCandidate[]): void {
  const { dataset } = entry;
  const n = PER_SHEET[dataset.scale]!;
  const w = SHEET_W / n;
  const h = SHEET_H / n;
  const col0 = Math.floor((tile.minE - WEST_ORIGIN) / w);
  const col1 = Math.ceil((tile.maxE - WEST_ORIGIN) / w) - 1;
  const row0 = Math.floor((NORTH_ORIGIN - tile.maxN) / h);
  const row1 = Math.ceil((NORTH_ORIGIN - tile.minN) / h) - 1;
  const digits = n === 100 ? 3 : 2;
  for (let row = Math.max(0, row0); row <= row1; row++) {
    const letters = ROW_LETTERS[Math.floor(row / n)];
    if (!letters) continue;
    for (let col = Math.max(0, col0); col <= col1; col++) {
      const sheet = `${letters}${String(Math.floor(col / n)).padStart(2, '0')}`;
      const mask = entry.masks.get(sheet);
      if (!mask) continue;
      const r = row % n;
      const c = col % n;
      if (!hasMaskBit(mask, r * n + c)) continue;
      const rc = `${String(r + 1).padStart(digits, '0')}${String(c + 1).padStart(digits, '0')}`;
      const minE = WEST_ORIGIN + col * w;
      const maxN = NORTH_ORIGIN - row * h;
      out.push({
        url: `${dataset.base}${dataset.name.replace('{sheet}', sheet).replace('{rc}', rc)}`,
        bounds: { minE, minN: maxN - h, maxE: minE + w, maxN },
        rank: entry.rank,
      });
    }
  }
}

const itemCache = new Map<string, string[]>();

/** Fichiers candidats d'une dalle de 1 km, du plus pertinent au moins pertinent. */
export async function resolveNzDownloadUrls(coord: NzTileCoord): Promise<string[]> {
  const key = nzTileKey(coord);
  const cached = itemCache.get(key);
  if (cached) return cached;

  const tile = getNzTileBounds(coord);
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

  const urls = rankTileCandidates(candidates, tile);
  itemCache.set(key, urls);
  return urls;
}
