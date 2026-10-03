import type { AhnDataset } from './types';
import { AHN_LIDAR_DATASETS, AHN_SHEET_GRID } from './ahnIndex';
import { hasMaskBit, type TileBounds } from '../tileCandidates';

/**
 * Sous-dalles AHN (GeoTiles) d'un point ou d'une emprise, à partir de l'index
 * généré `ahnIndex`. Une feuille AHN couvre 5 × 6,25 km en RD New (coin
 * sud-ouest multiple de la taille) ; ses 25 sous-dalles de 1 × 1,25 km sont
 * numérotées ligne par ligne depuis le nord-ouest. Les fichiers débordent de
 * 20 m autour de la sous-dalle (raccords sans couture).
 */

const SHEET_W = 5_000;
const SHEET_H = 6_250;
const SUB_W = 1_000;
const SUB_H = 1_250;
/** Entrées de `AHN_SHEET_GRID` : feuille (5) + colonne (2) + ligne (3), en unités de feuille. */
const GRID_ENTRY = 10;
/** Entrées de `sheets` : feuille (5) + masque des 25 sous-dalles (7). */
const SHEET_ENTRY = 12;

interface IndexedDataset {
  dataset: AhnDataset;
  /** Feuille → masque hex de ses sous-dalles. */
  masks: Map<string, string>;
}

let sheetAt: Map<string, string> | null = null;
let indexed: IndexedDataset[] | null = null;

function getIndex(): { sheetAt: Map<string, string>; datasets: IndexedDataset[] } {
  if (!sheetAt || !indexed) {
    sheetAt = new Map();
    for (let i = 0; i + GRID_ENTRY <= AHN_SHEET_GRID.length; i += GRID_ENTRY) {
      const name = AHN_SHEET_GRID.slice(i, i + 5);
      const col = Number(AHN_SHEET_GRID.slice(i + 5, i + 7));
      const row = Number(AHN_SHEET_GRID.slice(i + 7, i + 10));
      sheetAt.set(`${col},${row}`, name);
    }
    indexed = AHN_LIDAR_DATASETS.map((dataset) => {
      const masks = new Map<string, string>();
      for (let i = 0; i + SHEET_ENTRY <= dataset.sheets.length; i += SHEET_ENTRY) {
        masks.set(dataset.sheets.slice(i, i + 5), dataset.sheets.slice(i + 5, i + SHEET_ENTRY));
      }
      return { dataset, masks };
    });
  }
  return { sheetAt, datasets: indexed };
}

interface SubtileRef {
  sheet: string;
  /** Rang 0–24 de la sous-dalle (ligne par ligne depuis le nord-ouest). */
  bit: number;
  bounds: TileBounds;
}

function subtileAt(x: number, y: number): SubtileRef | null {
  const col = Math.floor(x / SHEET_W);
  const row = Math.floor(y / SHEET_H);
  const sheet = getIndex().sheetAt.get(`${col},${row}`);
  if (!sheet) return null;
  const subCol = Math.floor((x - col * SHEET_W) / SUB_W);
  const subRowFromSouth = Math.floor((y - row * SHEET_H) / SUB_H);
  const minE = col * SHEET_W + subCol * SUB_W;
  const minN = row * SHEET_H + subRowFromSouth * SUB_H;
  return {
    sheet,
    bit: (4 - subRowFromSouth) * 5 + subCol,
    bounds: { minE, minN, maxE: minE + SUB_W, maxN: minN + SUB_H },
  };
}

function subtileUrl(dataset: AhnDataset, ref: SubtileRef): string {
  return `${dataset.base}${ref.sheet}_${String(ref.bit + 1).padStart(2, '0')}.LAZ`;
}

/** Emprise (RD New, m) de la sous-dalle publiée sous le point, null hors couverture. */
export function findAhnFileFootprintAt(x: number, y: number): TileBounds | null {
  const ref = subtileAt(x, y);
  if (!ref) return null;
  const present = getIndex().datasets.some(({ masks }) => {
    const mask = masks.get(ref.sheet);
    return mask !== undefined && hasMaskBit(mask, ref.bit);
  });
  return present ? ref.bounds : null;
}

/** Fichiers de la sous-dalle d'emprise `footprint`, jeu le plus récent d'abord (URL amont, hors proxy). */
export function resolveAhnDownloadUrls(footprint: TileBounds): string[] {
  const ref = subtileAt((footprint.minE + footprint.maxE) / 2, (footprint.minN + footprint.maxN) / 2);
  if (!ref || ref.bounds.minE !== footprint.minE || ref.bounds.minN !== footprint.minN) return [];
  const urls: string[] = [];
  for (const { dataset, masks } of getIndex().datasets) {
    const mask = masks.get(ref.sheet);
    if (mask !== undefined && hasMaskBit(mask, ref.bit)) urls.push(subtileUrl(dataset, ref));
  }
  return urls;
}

/** Libellé du fichier (« AHN5 65AN2_20 ») pour les messages. */
export function describeAhnUrl(url: string): string {
  const match = url.match(/\/(AHN\d)_T\/(\w+)\.LAZ$/i);
  return match ? `${match[1]} ${match[2]}` : url;
}
