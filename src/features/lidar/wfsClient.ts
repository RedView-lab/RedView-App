import type { ZoneInfo, TileCoord } from './types';
import { toWgs84, buildTileFileName, isCorsica } from './coordConvert';

let zonesCache: ZoneInfo[] | null = null;
const tileUrlCache = new Map<string, string>();

const FALLBACK_ZONES_FXX = [
  'AE_2025-07-22', 'AF_2025-09-11', 'KH_2024-12-20', 'PM_2025-03-25',
  'QK_2025-06-13', 'QM_2025-03-14', 'QM_2025-02-20', 'LN_2025-02-10',
  'QM_2024-12-15', 'PM_2024-12-15', 'PK_2024-12-15', 'QN_2024-12-15',
  'QL_2024-11-15', 'QO_2024-12-15', 'QP_2024-12-15',
];
const FALLBACK_ZONES_CORSE = ['VS_2025-04-02'];
const FALLBACK_ZONES_REU = ['REU_2025-06-18'];

function containsPoint(bbox: ZoneInfo['bbox'], lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function parseZonesXml(xmlText: string): ZoneInfo[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const entries = doc.getElementsByTagName('entry');
  const zones: ZoneInfo[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const titleEl = entry.getElementsByTagName('title')[0];
    if (!titleEl?.textContent) continue;
    const name = titleEl.textContent.trim();

    let bboxStr: string | null = null;
    const links = entry.getElementsByTagName('link');
    for (let j = 0; j < links.length; j++) {
      const attr = links[j].getAttribute('gpf_dl:bbox');
      if (attr) { bboxStr = attr; break; }
    }
    if (!bboxStr) continue;

    const bboxParts = bboxStr.trim().split(/\s+/).map(Number);
    if (bboxParts.length < 4 || bboxParts.some(isNaN)) continue;

    const dateMatch = name.match(/(\d{4}-\d{2}-\d{2})$/);
    zones.push({
      name,
      bbox: { west: bboxParts[0], south: bboxParts[1], east: bboxParts[2], north: bboxParts[3] },
      date: dateMatch ? dateMatch[1] : '2000-01-01',
    });
  }

  return zones;
}

async function fetchAllZones(): Promise<ZoneInfo[]> {
  if (zonesCache) return zonesCache;

  const allZones: ZoneInfo[] = [];
  let page = 1;
  let maxPages = 1;

  try {
    while (page <= maxPages) {
      const response = await fetch(`/api/lidar/zones?page=${page}`);
      if (!response.ok) throw new Error(`WFS error: ${response.status}`);

      const xmlText = await response.text();
      const zones = parseZonesXml(xmlText);
      allZones.push(...zones);

      if (page === 1) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        const feedEl = doc.getElementsByTagName('feed')[0];
        if (feedEl) {
          const pcAttr = feedEl.getAttribute('gpf_dl:pagecount');
          if (pcAttr) maxPages = parseInt(pcAttr, 10) || 1;
        }
      }

      page++;
      if (page <= maxPages) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    allZones.sort((a, b) => b.date.localeCompare(a.date));
    zonesCache = allZones;
    console.log(`[WFS] Fetched ${allZones.length} LiDAR HD zones`);
    return allZones;
  } catch (err) {
    console.warn('[WFS] Failed to fetch zones, using fallback list:', err);
    return [];
  }
}

function buildFallbackUrls(coord: TileCoord): string[] {
  let fallbackCodes: string[];
  if (coord.projection === 'RGR92UTM40S') {
    fallbackCodes = FALLBACK_ZONES_REU;
  } else {
    const corsica = isCorsica(coord.xKm * 1000 + 500, coord.yKm * 1000 + 500);
    fallbackCodes = corsica ? FALLBACK_ZONES_CORSE : FALLBACK_ZONES_FXX;
  }

  const baseName = buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef);
  const urls: string[] = [];

  for (const code of fallbackCodes) {
    const zoneName = `NUALHD_1-0__LAZ_${coord.projection}_${code}`;
    urls.push(`/api/lidar/download/${zoneName}/${baseName}.copc.laz`);
    urls.push(`/api/lidar/download/${zoneName}/${baseName}.laz`);
  }

  return urls;
}

export async function resolveDownloadUrls(coord: TileCoord): Promise<string[]> {
  const cacheKey = `${coord.xKm},${coord.yKm}`;
  const cached = tileUrlCache.get(cacheKey);
  if (cached) return [cached];

  const centerX = coord.xKm * 1000 + 500;
  const centerY = coord.yKm * 1000 + 500;
  const [lon, lat] = toWgs84(centerX, centerY, coord.projection);

  const zones = await fetchAllZones();

  if (zones.length === 0) {
    return buildFallbackUrls(coord);
  }

  const matchingZones = zones.filter(z => containsPoint(z.bbox, lon, lat));

  if (matchingZones.length === 0) {
    return buildFallbackUrls(coord);
  }

  const urls: string[] = [];
  const baseName = buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef);

  for (const zone of matchingZones) {
    urls.push(`/api/lidar/download/${zone.name}/${baseName}.copc.laz`);
    urls.push(`/api/lidar/download/${zone.name}/${baseName}.laz`);
  }

  return urls;
}

export function cacheDownloadUrl(coord: TileCoord, url: string): void {
  const cacheKey = `${coord.xKm},${coord.yKm}`;
  tileUrlCache.set(cacheKey, url);
}

export function clearZonesCache(): void {
  zonesCache = null;
  tileUrlCache.clear();
}
