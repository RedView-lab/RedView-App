import type { NzTileCoord } from './types';
import {
  isInNzCoverage,
  nzTileCenterWgs84,
  nzTileKey,
} from './coordConvert';
import { NZ_LAZ_TILES } from './nzLazIndex';

/**
 * Client for New Zealand Raw LiDAR Point Cloud Open Data (OpenTopography / LINZ).
 *
 * Exclusively resolves genuine classified .laz point cloud files (Ground, Canopy,
 * Buildings, Intensity, Multi-returns) from the 181,171 indexed national tiles.
 */

const itemCache = new Map<string, string[]>();

// LINZ Topo50 2-letter Row Sequence (letters I and O omitted)
const ROW_LETTERS = [
  'AS', 'AT', 'AU', 'AV', 'AW', 'AX', 'AY', 'AZ',
  'BA', 'BB', 'BC', 'BD', 'BE', 'BF', 'BG', 'BH', 'BJ', 'BK', 'BL', 'BM', 'BN', 'BP', 'BQ', 'BR', 'BS', 'BT', 'BU', 'BV', 'BW', 'BX', 'BY', 'BZ',
  'CA', 'CB', 'CC', 'CD', 'CE', 'CF', 'CG', 'CH', 'CJ', 'CK', 'CL', 'CM', 'CN', 'CP', 'CQ', 'CR', 'CS', 'CT', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ'
];

const NORTH_ORIGIN = 6234000;
const WEST_ORIGIN = 988000;
const SHEET_WIDTH = 24000;
const SHEET_HEIGHT = 36000;

export interface Topo50TileInfo {
  sheetId: string;
  tileId10k: string;
  tileId1k: string;
  subRow10k: number;
  subCol10k: number;
  subRow1k: number;
  subCol1k: number;
}

/**
 * Calculate LINZ Topo50 sheet ID and 1:1,000 sub-tile ID from NZTM2000 coordinates.
 */
export function getTopo50TileInfo(eastM: number, northM: number): Topo50TileInfo | null {
  const colNum = Math.floor((eastM - WEST_ORIGIN) / SHEET_WIDTH);
  const rowIndex = Math.floor((NORTH_ORIGIN - northM) / SHEET_HEIGHT);

  if (rowIndex < 0 || rowIndex >= ROW_LETTERS.length || colNum < 0 || colNum > 99) {
    return null;
  }

  const sheetLetter = ROW_LETTERS[rowIndex];
  const sheetColStr = String(colNum).padStart(2, '0');
  const sheetId = `${sheetLetter}${sheetColStr}`;

  const sheetWest = WEST_ORIGIN + colNum * SHEET_WIDTH;
  const sheetNorth = NORTH_ORIGIN - rowIndex * SHEET_HEIGHT;

  const subCol10k = Math.min(5, Math.max(1, Math.floor((eastM - sheetWest) / 4800) + 1));
  const subRow10k = Math.min(5, Math.max(1, Math.floor((sheetNorth - northM) / 7200) + 1));

  const subCol1k = Math.min(50, Math.max(1, Math.floor((eastM - sheetWest) / 480) + 1));
  const subRow1k = Math.min(50, Math.max(1, Math.floor((sheetNorth - northM) / 720) + 1));

  const rowColStr10k = `${String(subRow10k).padStart(2, '0')}${String(subCol10k).padStart(2, '0')}`;
  const rowColStr1k = `${String(subRow1k).padStart(2, '0')}${String(subCol1k).padStart(2, '0')}`;

  const tileId10k = `${sheetId}_10000_${rowColStr10k}`;
  const tileId1k = `${sheetId}_1000_${rowColStr1k}`;

  return { sheetId, tileId10k, tileId1k, subRow10k, subCol10k, subRow1k, subCol1k };
}

/**
 * Resolve download candidates for an NZ tile (1km x 1km in NZTM2000).
 * Exclusively returns real classified LiDAR .laz point clouds.
 */
export async function resolveNzDownloadUrls(
  coord: NzTileCoord
): Promise<string[]> {
  const key = nzTileKey(coord);
  const cached = itemCache.get(key);
  if (cached && cached.length > 0) {
    return cached;
  }

  const [lon, lat] = nzTileCenterWgs84(coord);
  if (!isInNzCoverage(lon, lat)) return [];

  const eastM = coord.eastKm * 1000 + 500;
  const northM = coord.northKm * 1000 + 500;

  const topoInfo = getTopo50TileInfo(eastM, northM);
  if (!topoInfo) return [];

  const candidates: string[] = [];

  // 1. Direct lookup in pre-indexed 181,000+ real LiDAR .laz point clouds
  const rowColStr1k = `${String(topoInfo.subRow1k).padStart(2, '0')}${String(topoInfo.subCol1k).padStart(2, '0')}`;
  const directLaz = NZ_LAZ_TILES[`${topoInfo.sheetId}_${rowColStr1k}`];
  if (directLaz && directLaz.length > 0) {
    candidates.push(...directLaz);
  }

  // 2. Check adjacent sub-tiles intersecting the 1km x 1km footprint
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = topoInfo.subRow1k + dr;
      const c = topoInfo.subCol1k + dc;
      if (r >= 1 && r <= 50 && c >= 1 && c <= 50) {
        const neighborKey = `${topoInfo.sheetId}_${String(r).padStart(2, '0')}${String(c).padStart(2, '0')}`;
        const neighborHits = NZ_LAZ_TILES[neighborKey];
        if (neighborHits) candidates.push(...neighborHits);
      }
    }
  }

  // Deduplicate candidate URLs
  const uniqueCandidates = Array.from(new Set(candidates));

  if (uniqueCandidates.length > 0) {
    itemCache.set(key, uniqueCandidates);
  }

  return uniqueCandidates;
}

/** Cache clear helper */
export function clearNzStacCache(): void {
  itemCache.clear();
}
