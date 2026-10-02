import type { JapanLidarDataset, JapanTileCoord } from './types';
import { getJapanTileBounds, japanTileKey } from './coordConvert';
import { JAPAN_LIDAR_DATASETS } from './japanLazIndex';
import {
  boundsIntersect,
  hasMaskBit,
  parseBoundedTiles,
  rankTileCandidates,
  type TileBounds,
  type TileCandidate,
} from '../tileCandidates';

/**
 * Résolution des nuages de points LiDAR japonais d'une dalle de 1 km
 * (JGD2011 plan rectangulaire) à partir de l'index généré `japanLazIndex`.
 *
 * Les fichiers sont des sous-feuilles d'une feuille 1:5000 du 公共測量標準図郭
 * (3 km N-S × 4 km E-O) : 10×10, 4×4 ou quarts selon le jeu, ou une emprise
 * stockée par fichier (COPC de l'AIST, feuilles partielles). Seuls les jeux de
 * la zone de la dalle sont retenus : le viewer géoréférence le fichier avec la
 * zone de la dalle.
 */

const ROWS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const COLS = 'ABCDEFGH';
/** Grille des feuilles : X = +300 km au nord, Y = −160 km à l'ouest. */
const GRID_NORTH_M = 300_000;
const GRID_WEST_M = -160_000;
const SHEET_5K_N_M = 3_000;
const SHEET_5K_E_M = 4_000;
/** Sous-feuilles par côté de feuille 1:5000 selon le découpage. */
const SPLIT: Record<number, number> = { 500: 10, 1250: 4, 2500: 2 };

interface IndexedDataset {
  dataset: JapanLidarDataset;
  rank: number;
  /** Feuille 1:5000 (« ME28 ») → masque hex de ses sous-feuilles. */
  masks: Map<string, string>;
  tiles: { name: string; bounds: TileBounds }[];
}

let indexed: IndexedDataset[] | null = null;

function getIndexedDatasets(): IndexedDataset[] {
  if (indexed) return indexed;
  indexed = JAPAN_LIDAR_DATASETS.map((dataset, rank) => {
    const masks = new Map<string, string>();
    const n = SPLIT[dataset.level];
    if (n && dataset.sheets) {
      const entryLength = 4 + Math.ceil((n * n) / 4);
      for (let i = 0; i + entryLength <= dataset.sheets.length; i += entryLength) {
        masks.set(dataset.sheets.slice(i, i + 4), dataset.sheets.slice(i + 4, i + entryLength));
      }
    }
    return { dataset, rank, masks, tiles: parseBoundedTiles(dataset.tiles) };
  });
  return indexed;
}

/** Quart (1 = NO, 2 = NE, 3 = SO, 4 = SE) de la cellule (ligne, colonne) 0/1. */
const quarterOf = (r: number, c: number) => r * 2 + c + 1;

/** Sous-feuille → suffixe du code : « 37 » (10×10), « 34 » (quart puis quart de quart), « 3 » (quart). */
function subSheetSuffix(level: number, r: number, c: number): string {
  if (level === 500) return `${r}${c}`;
  if (level === 1250) return `${quarterOf(r >> 1, c >> 1)}${quarterOf(r & 1, c & 1)}`;
  return String(quarterOf(r, c));
}

function gridCandidates(entry: IndexedDataset, tile: TileBounds, out: TileCandidate[]): void {
  const { dataset } = entry;
  const n = SPLIT[dataset.level]!;
  const h = SHEET_5K_N_M / n;
  const w = SHEET_5K_E_M / n;
  const row0 = Math.floor((GRID_NORTH_M - tile.maxN) / h);
  const row1 = Math.ceil((GRID_NORTH_M - tile.minN) / h) - 1;
  const col0 = Math.floor((tile.minE - GRID_WEST_M) / w);
  const col1 = Math.ceil((tile.maxE - GRID_WEST_M) / w) - 1;
  const zone = String(dataset.zone).padStart(2, '0');
  const caseOf = (value: string) => (dataset.lower ? value.toLowerCase() : value);

  for (let row = Math.max(0, row0); row <= row1; row++) {
    const row5k = Math.floor(row / n);
    const rowLetter = ROWS[Math.floor(row5k / 10)];
    if (!rowLetter) continue;
    for (let col = Math.max(0, col0); col <= col1; col++) {
      const col5k = Math.floor(col / n);
      const colLetter = COLS[Math.floor(col5k / 10)];
      if (!colLetter) continue;
      const letters = `${rowLetter}${colLetter}`;
      const sheet5k = `${row5k % 10}${col5k % 10}`;
      const mask = entry.masks.get(letters + sheet5k);
      const r = row % n;
      const c = col % n;
      if (!mask || !hasMaskBit(mask, r * n + c)) continue;
      const dir = dataset.dir.replace('{z}', zone).replace('{L}', caseOf(letters)).replace('{s}', sheet5k);
      const code = caseOf(`${zone}${letters}${sheet5k}${subSheetSuffix(dataset.level, r, c)}`);
      const maxN = GRID_NORTH_M - row * h;
      const minE = GRID_WEST_M + col * w;
      out.push({
        url: `${dataset.base}${dir}${code}${dataset.ext}`,
        bounds: { minE, minN: maxN - h, maxE: minE + w, maxN },
        rank: entry.rank,
      });
    }
  }
}

const itemCache = new Map<string, string[]>();

/** Fichiers candidats d'une dalle de 1 km, du plus pertinent au moins pertinent. */
export async function resolveJapanDownloadUrls(coord: JapanTileCoord): Promise<string[]> {
  const key = japanTileKey(coord);
  const cached = itemCache.get(key);
  if (cached) return cached;

  const tile = getJapanTileBounds(coord);
  const candidates: TileCandidate[] = [];
  for (const entry of getIndexedDatasets()) {
    if (entry.dataset.zone !== coord.zone) continue;
    if (entry.dataset.level) {
      gridCandidates(entry, tile, candidates);
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
