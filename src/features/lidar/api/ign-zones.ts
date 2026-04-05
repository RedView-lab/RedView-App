import type { ZoneInfo, TileCoord } from '../types/geometry';
import { toWgs84, buildTileFileName, isCorsica } from '../processing/coord-transform';

const FALLBACK_ZONES_FXX = [
  'AE_2025-07-22', 'AF_2025-09-11', 'KH_2024-12-20', 'PM_2025-03-25',
  'QK_2025-06-13', 'QM_2025-03-14', 'QM_2025-02-20', 'LN_2025-02-10',
  'QM_2024-12-15', 'PM_2024-12-15', 'PK_2024-12-15', 'QN_2024-12-15',
  'QL_2024-11-15', 'QO_2024-12-15', 'QP_2024-12-15',
];
const FALLBACK_ZONES_CORSE = ['VS_2025-04-02'];
const FALLBACK_ZONES_REU = ['REU_2025-06-18'];

let zonesCache: ZoneInfo[] | null = null;
const tileUrlCache = new Map<string, string>();

function containsPoint(bbox: ZoneInfo['bbox'], lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function parseZonesXml(xmlText: string): ZoneInfo[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const entries = doc.querySelectorAll('entry');
  const zones: ZoneInfo[] = [];

  for (const entry of entries) {
    const title = entry.querySelector('title')?.textContent?.trim() ?? '';
    if (!title) continue;

    const bboxAttr = entry.querySelector('[bbox]')?.getAttribute('bbox')
      ?? entry.querySelector('georss\\:box, box')?.textContent?.trim()
      ?? '';

    let west = -180, south = -90, east = 180, north = 90;
    if (bboxAttr) {
      const parts = bboxAttr.split(/[\s,]+/).map(Number);
      if (parts.length >= 4 && parts.every(n => !isNaN(n))) {
        [south, west, north, east] = parts;
      }
    }

    const dateMatch = title.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : '';

    zones.push({ name: title, bbox: { west, south, east, north }, date });
  }

  zones.sort((a, b) => b.date.localeCompare(a.date));
  return zones;
}

async function fetchAllZones(): Promise<ZoneInfo[]> {
  if (zonesCache) return zonesCache;

  try {
    const allZones: ZoneInfo[] = [];
    let page = 1;
    let totalPages = 1;

    for (; page <= totalPages; page++) {
      const resp = await fetch(`/api/lidar-zones?page=${page}`);
      if (!resp.ok) break;
      const text = await resp.text();

      if (page === 1) {
        const match = text.match(/pagecount="(\d+)"/i);
        if (match) totalPages = parseInt(match[1], 10);
      }

      allZones.push(...parseZonesXml(text));
      if (page < totalPages) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    zonesCache = allZones;
    return allZones;
  } catch (err) {
    console.warn('[lidar] Failed to fetch WFS zones:', err);
    return [];
  }
}

function buildFallbackUrls(coord: TileCoord): string[] {
  const baseName = buildTileFileName(coord);
  const x = coord.xKm * 1000 + 500;
  const y = coord.yKm * 1000 + 500;

  let codes: string[];
  if (coord.territory === 'REU') {
    codes = FALLBACK_ZONES_REU;
  } else if (isCorsica(x, y)) {
    codes = FALLBACK_ZONES_CORSE;
  } else {
    codes = FALLBACK_ZONES_FXX;
  }

  const urls: string[] = [];
  for (const zone of codes) {
    const zoneName = `NUALHD_1-0__LAZ_LAMB93_${zone}`;
    urls.push(`/api/lidar-download?zone=${encodeURIComponent(zoneName)}&file=${baseName}.copc.laz`);
    urls.push(`/api/lidar-download?zone=${encodeURIComponent(zoneName)}&file=${baseName}.laz`);
  }
  return urls;
}

export async function resolveDownloadUrls(coord: TileCoord): Promise<string[]> {
  const cacheKey = `${coord.xKm}_${coord.yKm}_${coord.territory}`;
  const cached = tileUrlCache.get(cacheKey);
  if (cached) return [cached];

  const [lon, lat] = toWgs84(coord.xKm * 1000 + 500, coord.yKm * 1000 + 500, coord.projection);
  const zones = await fetchAllZones();
  const matching = zones.filter(z => containsPoint(z.bbox, lon, lat));

  if (matching.length === 0) return buildFallbackUrls(coord);

  const baseName = buildTileFileName(coord);
  const urls: string[] = [];
  for (const zone of matching) {
    urls.push(`/api/lidar-download?zone=${encodeURIComponent(zone.name)}&file=${baseName}.copc.laz`);
    urls.push(`/api/lidar-download?zone=${encodeURIComponent(zone.name)}&file=${baseName}.laz`);
  }
  return urls;
}

export function cacheDownloadUrl(coord: TileCoord, url: string): void {
  const cacheKey = `${coord.xKm}_${coord.yKm}_${coord.territory}`;
  tileUrlCache.set(cacheKey, url);
}

export function clearZonesCache(): void {
  zonesCache = null;
  tileUrlCache.clear();
}
