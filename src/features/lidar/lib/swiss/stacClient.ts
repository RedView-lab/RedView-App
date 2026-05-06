import type { SwissTileCoord, SwissTileStacItem } from './types';
import {
  isInSwissCoverage,
  swissTileCenterWgs84,
  swissTileKey,
} from './coordConvert';

/**
 * STAC client for the swisstopo swissSURFACE3D point cloud collection.
 *
 * Public, no-auth STAC API:
 *   https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d
 *
 * Tile URL is fully predictable from (year, eastKm, northKm), e.g.:
 *   https://data.geo.admin.ch/ch.swisstopo.swisssurface3d/
 *     swisssurface3d_2015_2494-1140/
 *     swisssurface3d_2015_2494-1140_2056_5728.las.zip
 *
 * The acquisition year varies per tile, so we resolve the actual asset href
 * via STAC item lookup (item id = `swisssurface3d_<year>_<E>-<N>`).
 *
 * Files are LASzip (.las.zip), height reference LN02 (EPSG:5728).
 */

const STAC_BASE =
  'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d';
const ASSET_BASE = 'https://data.geo.admin.ch/ch.swisstopo.swisssurface3d';

// Years known to be published on data.geo.admin.ch.
// Used by buildFallbackUrls() when the STAC items query fails (offline / blocked).
// Most-recent first so the freshest acquisition wins.
const FALLBACK_YEARS = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015];

const itemCache = new Map<string, SwissTileStacItem[]>();

interface StacAsset {
  href: string;
  type?: string;
}

interface StacItem {
  id: string;
  collection?: string;
  properties?: { datetime?: string };
  assets?: Record<string, StacAsset>;
}

interface StacItemCollection {
  type: 'FeatureCollection';
  features: StacItem[];
  links?: { rel: string; href: string }[];
}

function parseItemId(id: string): { year: number; coord: SwissTileCoord } | null {
  // swisssurface3d_<year>_<E>-<N>
  const m = id.match(/^swisssurface3d_(\d{4})_(\d{3,4})-(\d{3,4})$/);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    coord: { eastKm: parseInt(m[2], 10), northKm: parseInt(m[3], 10) },
  };
}

function pickLazAsset(item: StacItem): StacAsset | null {
  if (!item.assets) return null;
  // Prefer .las.zip (LASzip) assets; tolerate .laz / .copc.laz if ever added.
  const entries = Object.entries(item.assets);
  const preferred = entries.find(([k]) => /\.las\.zip$/i.test(k));
  if (preferred) return preferred[1];
  const laz = entries.find(([k]) => /\.copc\.laz$/i.test(k))
    ?? entries.find(([k]) => /\.laz$/i.test(k));
  return laz ? laz[1] : null;
}

function itemToStacItem(item: StacItem): SwissTileStacItem | null {
  const parsed = parseItemId(item.id);
  if (!parsed) return null;
  const asset = pickLazAsset(item);
  if (!asset?.href) return null;
  return {
    id: item.id,
    year: parsed.year,
    coord: parsed.coord,
    href: asset.href,
    contentType: asset.type,
    datetime: item.properties?.datetime,
  };
}

/**
 * Build the predictable .las.zip URL for a given year + tile, without
 * hitting the STAC API. Used as last-resort fallback.
 */
function buildPredictedUrl(year: number, coord: SwissTileCoord): string {
  const tileId = `swisssurface3d_${year}_${coord.eastKm}-${coord.northKm}`;
  return `${ASSET_BASE}/${tileId}/${tileId}_2056_5728.las.zip`;
}

/**
 * Query the STAC API for every available item that matches the tile id stem
 * `swisssurface3d_<year>_<E>-<N>`. We filter by a tiny bbox around the tile
 * centre to keep the response small.
 *
 * Returns one entry per acquisition year (sorted newest first).
 */
export async function fetchSwissTileItems(
  coord: SwissTileCoord
): Promise<SwissTileStacItem[]> {
  const key = swissTileKey(coord);
  const cached = itemCache.get(key);
  if (cached) return cached;

  const [lon, lat] = swissTileCenterWgs84(coord);
  if (!isInSwissCoverage(lon, lat)) {
    itemCache.set(key, []);
    return [];
  }

  // Tight bbox (~10 m around tile centre) — STAC bbox is in WGS84 lon/lat.
  const eps = 0.0001;
  const bbox = `${lon - eps},${lat - eps},${lon + eps},${lat + eps}`;
  const url = `${STAC_BASE}/items?bbox=${bbox}&limit=50`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`STAC HTTP ${res.status}`);
    const json = (await res.json()) as StacItemCollection;
    const items = (json.features ?? [])
      .map(itemToStacItem)
      .filter((x): x is SwissTileStacItem => x !== null)
      .filter(x => x.coord.eastKm === coord.eastKm && x.coord.northKm === coord.northKm)
      .sort((a, b) => b.year - a.year);

    itemCache.set(key, items);
    console.log(
      `[Swiss STAC] Tile ${key} → ${items.length} item(s)` +
        (items.length > 0 ? ` (years: ${items.map(i => i.year).join(', ')})` : '')
    );
    return items;
  } catch (err) {
    console.warn(`[Swiss STAC] Lookup failed for tile ${key}:`, err);
    itemCache.set(key, []);
    return [];
  }
}

/**
 * Resolve the list of candidate download URLs for a swissSURFACE3D tile.
 *
 * Strategy:
 *   1. Ask the STAC API for the actual published item(s) — gives the exact
 *      acquisition year and asset href.
 *   2. If the STAC call fails or returns nothing, fall back to predicted URLs
 *      built from FALLBACK_YEARS. Caller is expected to try them in order
 *      and stop on the first 200.
 */
export async function resolveSwissDownloadUrls(
  coord: SwissTileCoord
): Promise<string[]> {
  const items = await fetchSwissTileItems(coord);
  if (items.length > 0) return items.map(i => i.href);

  const [lon, lat] = swissTileCenterWgs84(coord);
  if (!isInSwissCoverage(lon, lat)) return [];

  console.log(
    `[Swiss STAC] No items found for ${swissTileKey(coord)}, using ${FALLBACK_YEARS.length} predicted URLs`
  );
  return FALLBACK_YEARS.map(y => buildPredictedUrl(y, coord));
}

/** Test hook — clears in-memory STAC cache. */
export function clearSwissStacCache(): void {
  itemCache.clear();
}
