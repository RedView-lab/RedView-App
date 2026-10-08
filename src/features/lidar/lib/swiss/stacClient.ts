import type { SwissTileCoord, SwissTileStacItem } from './types';
import {
  isInSwissCoverage,
  swissTileCenterWgs84,
  swissTileKey,
} from './coordConvert';

/**
 * Client STAC pour la collection de nuages de points swissSURFACE3D de swisstopo.
 *
 * API STAC publique, sans authentification :
 *   https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d
 *
 * L'URL d'une tuile se déduit entièrement de (année, eastKm, northKm), par ex. :
 *   https://data.geo.admin.ch/ch.swisstopo.swisssurface3d/
 *     swisssurface3d_2015_2494-1140/
 *     swisssurface3d_2015_2494-1140_2056_5728.las.zip
 *
 * L'année d'acquisition varie selon la tuile : on résout donc le vrai href de
 * l'asset par une recherche d'item STAC (id d'item = `swisssurface3d_<year>_<E>-<N>`).
 *
 * Fichiers LASzip (.las.zip), référence altimétrique LN02 (EPSG:5728).
 */

const STAC_BASE =
  'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d';
const ASSET_BASE = 'https://data.geo.admin.ch/ch.swisstopo.swisssurface3d';

// Années connues comme publiées sur data.geo.admin.ch.
// Utilisées par buildFallbackUrls() quand la requête d'items STAC échoue (hors ligne / bloquée).
// La plus récente d'abord, pour que l'acquisition la plus fraîche l'emporte.
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
  // Préférer les assets .las.zip (LASzip) ; tolérer .laz / .copc.laz s'il en apparaît.
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
 * Construit l'URL .las.zip prévisible pour une année + une tuile, sans
 * interroger l'API STAC. Sert de dernier recours.
 */
function buildPredictedUrl(year: number, coord: SwissTileCoord): string {
  const tileId = `swisssurface3d_${year}_${coord.eastKm}-${coord.northKm}`;
  return `${ASSET_BASE}/${tileId}/${tileId}_2056_5728.las.zip`;
}

/**
 * Interroge l'API STAC pour chaque item disponible correspondant au préfixe
 * d'id de tuile `swisssurface3d_<year>_<E>-<N>`. On filtre sur une toute petite
 * emprise autour du centre de la tuile pour garder une réponse courte.
 *
 * Renvoie une entrée par année d'acquisition (la plus récente d'abord), ou
 * `null` quand l'API STAC elle-même est injoignable (hors ligne / bloquée) —
 * l'appelant peut alors utiliser les URL prévues. Un tableau vide signifie que
 * l'API a répondu et que swisstopo n'a définitivement aucun item pour cette tuile.
 */
async function fetchSwissTileItems(
  coord: SwissTileCoord
): Promise<SwissTileStacItem[] | null> {
  const key = swissTileKey(coord);
  const cached = itemCache.get(key);
  if (cached) return cached;

  const [lon, lat] = swissTileCenterWgs84(coord);
  if (!isInSwissCoverage(lon, lat)) {
    itemCache.set(key, []);
    return [];
  }

  // Emprise serrée (~10 m autour du centre de la tuile) — l'emprise STAC est en lon/lat WGS84.
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
    // STAC injoignable : NE PAS mettre en cache — un nouvel essai pourra réussir.
    console.warn(`[Swiss STAC] Lookup failed for tile ${key}:`, err);
    return null;
  }
}

/**
 * Résout la liste des URL de téléchargement candidates d'une tuile swissSURFACE3D.
 *
 * Stratégie :
 *   1. Demander à l'API STAC le ou les items réellement publiés — donne l'année
 *      d'acquisition exacte et le href de l'asset.
 *   2. Si l'API répond sans item pour cette tuile, swisstopo n'a définitivement
 *      pas de couverture ici : renvoyer [] pour que l'appelant se rabatte sur un
 *      autre fournisseur (par ex. IGN LiDAR HD de l'autre côté de la frontière)
 *      sans gaspiller de requêtes sur des URL prévues.
 *   3. Si l'appel STAC lui-même échoue, se rabattre sur des URL prévues construites
 *      à partir de FALLBACK_YEARS. L'appelant doit les essayer dans l'ordre et
 *      s'arrêter au premier 200.
 */
export async function resolveSwissDownloadUrls(
  coord: SwissTileCoord
): Promise<string[]> {
  const items = await fetchSwissTileItems(coord);
  if (items === null) {
    // STAC injoignable — au mieux avec des URL prévues.
    const [lon, lat] = swissTileCenterWgs84(coord);
    if (!isInSwissCoverage(lon, lat)) return [];
    console.log(
      `[Swiss STAC] API unreachable for ${swissTileKey(coord)}, using ${FALLBACK_YEARS.length} predicted URLs`
    );
    return FALLBACK_YEARS.map(y => buildPredictedUrl(y, coord));
  }
  return items.map(i => i.href);
}

