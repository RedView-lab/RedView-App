import type { JapanTileCoord } from './types';
import {
  isInJapanCoverage,
  japanTileCenterWgs84,
  japanTileKey,
  getJapanTileBounds,
  japanCoordsToStandardSheet,
} from './coordConvert';
import { resolveIndexedJapanUrls } from './japanLazIndex';

const itemCache = new Map<string, string[]>();

/**
 * Resolve download candidate URLs for a Japan 1km² tile in JGD2011 Plane Rectangular CS.
 * Uses the pre-indexed 107,119 real LiDAR .laz/.las tiles for instant O(1) resolution.
 */
export async function resolveJapanDownloadUrls(
  coord: JapanTileCoord
): Promise<string[]> {
  const key = japanTileKey(coord);
  const cached = itemCache.get(key);
  if (cached && cached.length > 0) {
    return cached;
  }

  const [lon, lat] = japanTileCenterWgs84(coord);
  if (!isInJapanCoverage(lon, lat)) return [];

  const { minE, minN, maxE, maxN } = getJapanTileBounds(coord);
  const midE = (minE + maxE) / 2;
  const midN = (minN + maxN) / 2;

  // Sample points across the 1km² footprint
  const samplePoints: [number, number][] = [
    [midE, midN],
    [minE + 150, minN + 150],
    [maxE - 150, minN + 150],
    [minE + 150, maxN - 150],
    [maxE - 150, maxN - 150],
    [minE + 150, midN],
    [maxE - 150, midN],
    [midE, minN + 150],
    [midE, maxN - 150],
  ];

  const candidates: string[] = [];

  for (const [e, n] of samplePoints) {
    const sheet = japanCoordsToStandardSheet(e, n, coord.zone);
    const directHits = resolveIndexedJapanUrls(sheet.sheetCode);
    if (directHits && directHits.length > 0) {
      candidates.push(...directHits);
    }
  }

  // Deduplicate candidate URLs
  const uniqueCandidates = Array.from(new Set(candidates));

  if (uniqueCandidates.length > 0) {
    itemCache.set(key, uniqueCandidates);
  }

  return uniqueCandidates;
}

/** Clear in-memory cache */
export function clearJapanCache(): void {
  itemCache.clear();
}
