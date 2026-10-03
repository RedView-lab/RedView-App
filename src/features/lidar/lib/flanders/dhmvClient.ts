import type { DhmvStrip } from './types';
import { DHMV_CELL_GRID, DHMV_CELL_M } from './dhmvIndex';
import { hasMaskBit, type TileBounds } from '../tileCandidates';

/**
 * Cellules LiDAR DHMV II (Flandre) : 500 × 500 m en Lambert 72. Chaque
 * cellule réunit les morceaux des bandes de vol qui la survolent ; leur liste
 * vient du WFS EODaS OpenLidar (CORS ouvert) au moment du téléchargement, les
 * fichiers sont ensuite fusionnés en un seul nuage (`lasMerge.ts`).
 */

const WFS = 'https://remotesensing.vlaanderen.be/services/openlidar/wfs';
const LAYER = 'openlidar:LiDAR_DHMV_II_LAZtiles';
const DOWNLOAD_BASE = 'https://remotesensing.vlaanderen.be/download/openlidar/';
/**
 * Plafond d'une cellule fusionnée (64 pts/m², ~330 Mo en LAS brut) : seul ~1 %
 * des cellules le dépasse (recouvrements de 10 bandes et plus), éclairci
 * uniformément au-delà.
 */
export const DHMV_MAX_CELL_POINTS = 16_000_000;
/** Chemins publiés : `LiDAR_DHMV_2_V2/…/Tiles/…_<X>_<Y>.laz`, sans `..`. */
const SAFE_LOCATION = /^LiDAR_DHMV_2_V2\/[\w/-]+\.laz$/i;

function cellBounds(col: number, row: number): TileBounds {
  const minE = col * DHMV_CELL_M;
  const minN = row * DHMV_CELL_M;
  return { minE, minN, maxE: minE + DHMV_CELL_M, maxN: minN + DHMV_CELL_M };
}

/** Emprise (Lambert 72, m) de la cellule couverte sous le point, null hors couverture. */
export function findDhmvCellFootprintAt(x: number, y: number): TileBounds | null {
  const { minCol, minRow, cols, rows, mask } = DHMV_CELL_GRID;
  const col = Math.floor(x / DHMV_CELL_M);
  const row = Math.floor(y / DHMV_CELL_M);
  const c = col - minCol;
  const r = row - minRow;
  if (c < 0 || r < 0 || c >= cols || r >= rows || !hasMaskBit(mask, r * cols + c)) return null;
  return cellBounds(col, row);
}

interface WfsResponse {
  features?: { properties?: { tile_location?: unknown; tile_totalpoints?: unknown } }[];
}

/**
 * Morceaux de bandes de la cellule d'emprise `footprint` (WFS). La requête
 * vise l'intérieur de la cellule ; seuls les fichiers nommés d'après son coin
 * sud-ouest sont retenus (les cellules voisines touchent la bbox).
 */
export async function resolveDhmvStrips(footprint: TileBounds, signal?: AbortSignal): Promise<DhmvStrip[]> {
  const inset = 1;
  const bbox = [footprint.minE + inset, footprint.minN + inset, footprint.maxE - inset, footprint.maxN - inset].join(',');
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: LAYER,
    outputFormat: 'application/json',
    propertyName: 'tile_location,tile_totalpoints',
    count: '200',
    bbox: `${bbox},EPSG:31370`,
  });
  const response = await fetch(`${WFS}?${params}`, { signal });
  if (!response.ok) throw new Error(`WFS OpenLidar HTTP ${response.status}`);
  const data = (await response.json()) as WfsResponse;
  const suffix = `_${footprint.minE}_${footprint.minN}.laz`;
  const strips = new Map<string, DhmvStrip>();
  for (const feature of data.features ?? []) {
    const location = feature.properties?.tile_location;
    if (typeof location !== 'string' || !SAFE_LOCATION.test(location) || !location.toLowerCase().endsWith(suffix)) continue;
    const points = Number(feature.properties?.tile_totalpoints) || 0;
    strips.set(location, { url: `${DOWNLOAD_BASE}${location}`, points });
  }
  return [...strips.values()].sort((a, b) => b.points - a.points);
}
