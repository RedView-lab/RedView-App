import type { ZoneInfo, TileCoord } from './types';
import { toWgs84, buildTileFileName, isCorsica } from './coordConvert';

const IGN_DL_BASE = 'https://data.geopf.fr/telechargement';

let zonesCache: ZoneInfo[] | null = null;
const tileUrlCache = new Map<string, string>();

// Auto-generated from IGN Géoplateforme WFS (206 zones)
const FALLBACK_ZONES_FXX = [
  // Brittany / Normandy
  'AE_2025-07-22', 'AF_2025-09-11', 'BE_2025-09-22', 'CE_2026-01-22',
  'DE_2026-01-20', 'DF_2025-01-06', 'DH_2025-03-03', 'DI_2025-01-16',
  // Western France
  'EF_2025-01-23', 'EG_2025-01-06', 'EH_2025-07-21', 'EI_2025-05-16',
  'EJ_2025-07-24', 'EM_2025-07-01', 'EN_2025-10-14', 'EO_2025-10-08',
  'EP_2025-09-24', 'EQ_2025-09-26', 'ER_2025-07-08',
  // Northern France / Île-de-France
  'FD_2025-09-19', 'FE_2025-10-15', 'FF_2025-07-22', 'FG_2024-12-20',
  'FH_2025-06-13', 'FI_2025-01-24', 'FJ_2025-01-23', 'FK_2025-02-04',
  'FN_2025-07-29', 'FO_2025-09-15', 'FP_2025-08-07', 'FQ_2025-09-15',
  'FR_2025-03-21',
  // Paris region / Northern
  'GD_2025-01-08', 'GE_2026-03-06', 'GF_2025-07-23', 'GG_2024-12-20',
  'GH_2024-12-23', 'GI_2025-02-18', 'GJ_2025-01-27', 'GL_2026-01-14',
  'GM_2025-05-13', 'GN_2024-12-13', 'GO_2025-09-22', 'GP_2025-03-28',
  'GQ_2025-04-11', 'GR_2025-04-03',
  // Northeast
  'HC_2025-10-29', 'HD_2025-09-26', 'HE_2025-07-31', 'HF_2024-12-16',
  'HG_2024-12-20', 'HH_2025-06-20', 'HI_2024-12-02', 'HJ_2024-12-02',
  'HK_2025-01-10', 'HL_2025-05-27', 'HM_2025-06-26', 'HN_2025-06-11',
  'HO_2025-02-20', 'HP_2025-04-08', 'HQ_2025-03-25', 'HR_2025-04-18',
  // Eastern France
  'IC_2024-12-20', 'ID_2024-12-20', 'IE_2024-12-04', 'IF_2025-07-28',
  'IG_2025-01-23', 'IH_2024-12-03', 'II_2024-12-20', 'IJ_2025-01-24',
  'IL_2025-08-06', 'IM_2025-02-20', 'IN_2025-03-14', 'IO_2025-04-02',
  'IP_2025-04-10', 'IQ_2024-12-20', 'IR_2025-03-20',
  // Alps / Jura
  'JA_2025-08-13', 'JB_2025-07-07', 'JC_2024-12-20', 'JD_2024-12-20',
  'JE_2025-06-05', 'JG_2024-12-20', 'JH_2024-12-20', 'JI_2024-12-20',
  'JJ_2025-01-17', 'JL_2025-06-30', 'JM_2025-05-14', 'JN_2025-05-16',
  'JO_2025-03-25', 'JP_2025-04-09', 'JQ_2025-03-14', 'JR_2025-04-11',
  'JS_2025-03-26',
  // Southeast / Rhône-Alpes
  'KA_2025-07-22', 'KB_2025-08-06', 'KC_2025-06-03', 'KD_2025-06-24',
  'KE_2025-06-06', 'KF_2025-01-21', 'KG_2025-02-05', 'KH_2024-12-20',
  'KI_2025-06-12', 'KJ_2025-08-08', 'KL_2025-09-19', 'KM_2025-09-17',
  'KN_2025-01-29', 'KO_2025-02-06', 'KP_2025-02-06', 'KQ_2025-06-06',
  'KR_2025-03-18', 'KS_2025-05-20',
  // Massif Central / South
  'LB_2024-12-03', 'LC_2025-08-12', 'LG_2025-03-25', 'LH_2025-01-21',
  'LI_2025-06-17', 'LJ_2025-06-24', 'LK_2025-08-29', 'LL_2025-07-24',
  'LM_2025-06-26', 'LN_2025-02-10', 'LO_2024-12-13', 'LP_2025-02-28',
  'LQ_2025-05-19', 'LR_2025-03-28', 'LS_2025-04-15',
  // Southern France
  'MD_2025-08-29', 'ME_2025-08-28', 'MG_2025-07-03', 'MH_2025-10-15',
  'MJ_2024-12-23', 'MK_2025-01-14', 'ML_2025-09-15', 'MM_2025-03-12',
  'MN_2024-12-13', 'MO_2024-12-13', 'MP_2024-12-13', 'MQ_2024-12-19',
  // Mediterranean / Provence
  'NF_2025-03-12', 'NG_2026-02-03', 'NI_2025-10-20', 'NK_2025-02-20',
  'NL_2025-08-06', 'NM_2025-02-27', 'NN_2025-06-04', 'NO_2025-04-22',
  'NP_2024-12-19', 'NQ_2024-12-19',
  // Côte d'Azur / Languedoc
  'OE_2025-07-31', 'OG_2024-12-20', 'OK_2025-05-22', 'OL_2025-02-20',
  'OM_2025-03-25', 'ON_2025-08-13', 'OO_2025-03-14', 'OP_2025-03-14',
  'OQ_2025-03-12',
  // Pyrenees / Southwest
  'PD_2025-09-26', 'PE_2025-01-29', 'PF_2025-09-11', 'PG_2025-09-19',
  'PH_2025-07-10', 'PI_2025-07-17', 'PJ_2025-07-21', 'PK_2024-12-19',
  'PL_2025-03-07', 'PM_2025-03-25', 'PN_2025-02-20', 'PO_2025-04-02',
  'PP_2025-04-02', 'PQ_2025-03-14',
  // Alps (continued)
  'QD_2025-02-18', 'QE_2024-12-16', 'QF_2025-02-18', 'QG_2025-02-21',
  'QH_2025-05-22', 'QI_2025-06-26', 'QK_2025-06-13', 'QL_2025-03-26',
  'QM_2025-02-20', 'QN_2025-02-20', 'QO_2025-04-02', 'QP_2025-04-02',
  'QQ_2025-03-24', 'QR_2025-03-11',
  // Southeastern borders
  'RE_2025-02-17', 'RF_2024-12-20', 'RG_2024-12-20', 'RH_2025-05-20',
  'RL_2025-06-04', 'RM_2025-06-06', 'RN_2025-03-15', 'RO_2025-04-02',
  'RP_2025-03-06', 'RQ_2025-03-13',
  // Specialty zones
  'SE_2025-05-28', 'SP_2025-06-20', 'US_2025-04-02', 'UT_2025-04-02',
];
const FALLBACK_ZONES_CORSE = ['VS_2025-04-02', 'VT_2025-04-02', 'VU_2025-04-02'];
const FALLBACK_ZONES_REU = ['REU_2025-06-18'];

function containsPoint(bbox: ZoneInfo['bbox'], lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

/**
 * Strip <georss:polygon> from XML to reduce parsing overhead.
 * Previously done server-side in the Vercel proxy.
 */
function stripPolygons(xml: string): string {
  return xml
    .replace(/<georss:polygon>[\s\S]*?<\/georss:polygon>/g, '')
    .replace(/<georss:polygon\/>/g, '');
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
      const response = await fetch(`${IGN_DL_BASE}/resource/LiDARHD-NUALID?limit=100&page=${page}`);
      if (!response.ok) throw new Error(`WFS error: ${response.status}`);

      const xmlText = stripPolygons(await response.text());
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
    console.log(`[WFS] Fetched ${allZones.length} LiDAR HD zones (feed declares ${maxPages} pages)`);
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
    urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${zoneName}/${baseName}.copc.laz`);
    urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${zoneName}/${baseName}.laz`);
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

  console.log(`[WFS] Tile (${coord.xKm}, ${coord.yKm}) center WGS84: [${lon.toFixed(6)}, ${lat.toFixed(6)}] — ${matchingZones.length} matching zone(s)${matchingZones.length > 0 ? ': ' + matchingZones.map(z => z.name).join(', ') : ''}`);

  if (matchingZones.length === 0) {
    // Try nearby zones (within ~5km buffer) before giving up
    const BUFFER_DEG = 0.05;
    const nearbyZones = zones.filter(z =>
      lon >= z.bbox.west - BUFFER_DEG && lon <= z.bbox.east + BUFFER_DEG &&
      lat >= z.bbox.south - BUFFER_DEG && lat <= z.bbox.north + BUFFER_DEG
    );

    if (nearbyZones.length > 0) {
      console.log(`[WFS] No exact match, but ${nearbyZones.length} nearby zone(s): ${nearbyZones.map(z => z.name).join(', ')}`);
      const urls: string[] = [];
      const baseName = buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef);
      for (const zone of nearbyZones) {
        urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${zone.name}/${baseName}.copc.laz`);
        urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${zone.name}/${baseName}.laz`);
      }
      return urls;
    }

    console.warn(`[WFS] No zones contain or are near tile center — no LiDAR HD coverage at this location`);
    return [];
  }

  const urls: string[] = [];
  const baseName = buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef);

  for (const zone of matchingZones) {
    urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${zone.name}/${baseName}.copc.laz`);
    urls.push(`${IGN_DL_BASE}/download/LiDARHD-NUALID/${zone.name}/${baseName}.laz`);
  }

  console.log(`[WFS] Resolved ${urls.length} candidate URLs for tile (${coord.xKm}, ${coord.yKm})`);
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
