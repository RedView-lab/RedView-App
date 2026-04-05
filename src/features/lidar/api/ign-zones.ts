import type { ZoneInfo, TileCoord } from '../types/geometry';
import { toWgs84, buildTileFileName, isCorsica } from '../processing/coord-transform';

const FALLBACK_ZONES_FXX = [
  // Row A-B (Bretagne nord)
  'AE_2025-07-22', 'AF_2025-09-11', 'BE_2025-09-22',
  // Row C-D (Bretagne sud / Normandie)
  'CE_2026-01-22', 'DE_2026-01-20', 'DF_2025-01-06', 'DH_2025-03-03', 'DI_2025-01-16',
  // Row E (Atlantique / Centre-Ouest)
  'EF_2025-01-23', 'EG_2025-01-06', 'EH_2025-07-21', 'EI_2025-05-16', 'EJ_2025-07-24',
  'EM_2025-07-01', 'EN_2025-10-14', 'EO_2025-10-08', 'EP_2025-09-24', 'EQ_2025-09-26',
  'ER_2025-07-08',
  // Row F (Centre / Normandie)
  'FD_2025-09-19', 'FE_2025-10-15', 'FF_2025-07-22', 'FG_2024-12-20', 'FH_2025-06-13',
  'FI_2025-01-24', 'FJ_2025-01-23', 'FK_2025-02-04', 'FN_2025-07-29', 'FO_2025-09-15',
  'FP_2025-08-07', 'FQ_2025-09-15', 'FR_2025-03-21',
  // Row G (Ile-de-France / Centre)
  'GD_2025-01-08', 'GE_2026-03-06', 'GF_2025-07-23', 'GG_2024-12-20', 'GH_2024-12-23',
  'GI_2025-02-18', 'GJ_2025-01-27', 'GL_2026-01-14', 'GM_2025-05-13', 'GN_2024-12-13',
  'GO_2025-09-22', 'GP_2025-03-28', 'GQ_2025-04-11', 'GR_2025-04-03',
  // Row H (Nord / Picardie / Champagne)
  'HC_2025-10-29', 'HD_2025-09-26', 'HE_2025-07-31', 'HF_2024-12-16',
  // Row I-K (Est / Alsace / Lorraine / Bourgogne)
  'KH_2024-12-20',
  // Row L-N (Alpes / Jura / Rhône)
  'LN_2025-02-10',
  // Row P (Sud-Est / Provence / Languedoc)
  'PK_2024-12-15', 'PM_2025-03-25', 'PM_2024-12-15',
  // Row Q (Pyrénées / Méditerranée)
  'QK_2025-06-13', 'QL_2024-11-15', 'QM_2025-03-14', 'QM_2025-02-20', 'QM_2024-12-15',
  'QN_2024-12-15', 'QO_2024-12-15', 'QP_2024-12-15',
];
const FALLBACK_ZONES_CORSE = ['VS_2025-04-02'];
const FALLBACK_ZONES_REU = ['REU_2025-06-18'];

const ZONES_STORAGE_KEY = 'redview_lidar_zones_v1';

let zonesCache: ZoneInfo[] | null = null;
const tileUrlCache = new Map<string, string>();

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
    const title = entry.getElementsByTagName('title')[0]?.textContent?.trim() ?? '';
    if (!title) continue;

    // Extract bbox from gpf_dl:bbox attribute on <link> elements
    let bboxAttr = '';
    const links = entry.getElementsByTagName('link');
    for (let j = 0; j < links.length; j++) {
      const attr = links[j].getAttribute('gpf_dl:bbox');
      if (attr) { bboxAttr = attr; break; }
    }

    let west = -180, south = -90, east = 180, north = 90;
    if (bboxAttr) {
      const parts = bboxAttr.split(/[\s,]+/).map(Number);
      if (parts.length >= 4 && parts.every(n => !isNaN(n))) {
        [west, south, east, north] = parts;
      }
    }

    const dateMatch = title.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : '';

    zones.push({ name: title, bbox: { west, south, east, north }, date });
  }

  zones.sort((a, b) => b.date.localeCompare(a.date));
  return zones;
}

function saveZonesToStorage(zones: ZoneInfo[]): void {
  try {
    const data = JSON.stringify({ ts: Date.now(), zones });
    localStorage.setItem(ZONES_STORAGE_KEY, data);
  } catch { /* quota exceeded — ignore */ }
}

function loadZonesFromStorage(): ZoneInfo[] | null {
  try {
    const raw = localStorage.getItem(ZONES_STORAGE_KEY);
    if (!raw) return null;
    const { ts, zones } = JSON.parse(raw) as { ts: number; zones: ZoneInfo[] };
    // Expire after 7 days
    if (Date.now() - ts > 7 * 24 * 3600_000) return null;
    return zones;
  } catch {
    return null;
  }
}

async function fetchAllZones(): Promise<ZoneInfo[]> {
  if (zonesCache) return zonesCache;

  try {
    const allZones: ZoneInfo[] = [];
    let page = 1;
    let totalPages = 1;

    for (; page <= totalPages; page++) {
      const resp = await fetch(`/api/lidar-zones?page=${page}`);
      if (!resp.ok) {
        console.warn(`[lidar] Zone fetch page ${page} failed: HTTP ${resp.status}`);
        break;
      }
      const text = await resp.text();

      if (page === 1) {
        // Try to extract pagecount from <feed gpf_dl:pagecount="N"> attribute (matching earth-explorer)
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const feedEl = doc.getElementsByTagName('feed')[0];
        if (feedEl) {
          const pcAttr = feedEl.getAttribute('gpf_dl:pagecount');
          if (pcAttr) totalPages = parseInt(pcAttr, 10) || 1;
        }
        // Fallback: regex match
        if (totalPages === 1) {
          const match = text.match(/pagecount[="\s]+(\d+)/i);
          if (match) totalPages = parseInt(match[1], 10);
        }
      }

      const parsed = parseZonesXml(text);
      if (parsed.length === 0 && page > 1) break; // no more entries
      allZones.push(...parsed);
      if (page < totalPages) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (allZones.length > 0) {
      zonesCache = allZones;
      saveZonesToStorage(allZones);
      return allZones;
    }
  } catch (err) {
    console.warn('[lidar] Failed to fetch WFS zones:', err);
  }

  // Try localStorage cache before giving up
  const cached = loadZonesFromStorage();
  if (cached && cached.length > 0) {
    console.info(`[lidar] Using ${cached.length} cached zones from localStorage`);
    zonesCache = cached;
    return cached;
  }

  return [];
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
    const zoneName = `NUALHD_1-0__LAZ_${coord.projection}_${zone}`;
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
