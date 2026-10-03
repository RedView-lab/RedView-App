import type { DetectedCrs, TileCoord, TileFootprint } from '../types';
import { footprintTileCoord, fromWgs84, getTileInfo, parseJgd2011Zone } from './coordConvert';
import type { TileBounds } from './tileCandidates';

/**
 * Dalles-fichiers : au Japon, en NZ, aux Pays-Bas et en Flandre, les nuages
 * de points sont publiés par sous-feuille de grille nationale (240 × 360 m à
 * 1,5 × 2 km), sous-dalle AHN (1 × 1,25 km) ou cellule DHMV (500 m), pas par
 * dalle de 1 km. Le survol et le clic de sélection visent le fichier réel sous
 * le curseur, lu dans l'index du pays (chargé à la demande).
 *
 * Les Pays-Bas et la Flandre n'ont pas de grille kilométrique propre : la
 * dalle de 1 km du point y est celle de la France (Lambert-93, emprise IGN) ;
 * l'index AHN puis l'index DHMV prennent la main là où ils ont un fichier.
 */

type FileTerritory = 'NZ' | 'JP' | 'NL' | 'BE';
type FootprintFinder = (east: number, north: number, projection: DetectedCrs) => TileBounds | null;

const LOADERS: Record<FileTerritory, () => Promise<FootprintFinder>> = {
  NZ: () => import('./nz/stacClient').then(({ findNzFileFootprintAt }) => (east, north) => findNzFileFootprintAt(east, north)),
  JP: () => import('./japan/stacClient').then(({ findJapanFileFootprintAt }) => (east, north, projection) =>
    findJapanFileFootprintAt(east, north, parseJgd2011Zone(projection))),
  NL: () => import('./netherlands/ahnClient').then(({ findAhnFileFootprintAt }) => (east, north) => findAhnFileFootprintAt(east, north)),
  BE: () => import('./flanders/dhmvClient').then(({ findDhmvCellFootprintAt }) => (east, north) => findDhmvCellFootprintAt(east, north)),
};

/** Emprise WGS84 large des Pays-Bas et de la Flandre (Benelux continental). */
const BENELUX_BBOX = { west: 2.4, south: 50.6, east: 7.3, north: 53.7 };

interface FileSource {
  territory: FileTerritory;
  projection: DetectedCrs;
}

const finders: Partial<Record<FileTerritory, FootprintFinder>> = {};
const loads: Partial<Record<FileTerritory, Promise<void>>> = {};

/** Index pouvant servir le point, du prioritaire au repli. */
function fileSourcesAt(coord: TileCoord, lon: number, lat: number): FileSource[] {
  if (coord.territory === 'NZ' || coord.territory === 'JP') return [{ territory: coord.territory, projection: coord.projection }];
  if (
    coord.projection === 'LAMB93'
    && lon >= BENELUX_BBOX.west && lon <= BENELUX_BBOX.east
    && lat >= BENELUX_BBOX.south && lat <= BENELUX_BBOX.north
  ) {
    // AHN d'abord (plus récent, plus dense) : le long de la frontière, les
    // bandes flamandes débordent un peu sur les Pays-Bas et inversement.
    return [{ territory: 'NL', projection: 'RD_NEW' }, { territory: 'BE', projection: 'BL72' }];
  }
  return [];
}

function loadFinder(territory: FileTerritory): Promise<void> {
  loads[territory] ??= LOADERS[territory]()
    .then((finder) => {
      finders[territory] = finder;
    })
    .catch((err: unknown) => {
      // Index introuvable (déploiement remplacé…) : dalles de 1 km jusqu'au rechargement.
      console.warn(`[LiDAR] ${territory} file index unavailable, falling back to 1 km tiles:`, err);
      finders[territory] = () => null;
    });
  return loads[territory]!;
}

/** Charge les index des dalles-fichiers qui peuvent servir le point (sans effet ailleurs). */
export function loadFileTileIndex(coord: TileCoord, lon: number, lat: number): Promise<void> {
  return Promise.all(fileSourcesAt(coord, lon, lat).map(({ territory }) => loadFinder(territory))).then(() => undefined);
}

function toFootprint(bounds: TileBounds): TileFootprint {
  return { minX: bounds.minE, minY: bounds.minN, maxX: bounds.maxE, maxY: bounds.maxN };
}

function sourceBaseCoord(coord: TileCoord, source: FileSource): TileCoord {
  if (source.projection === coord.projection) return coord;
  const info = getTileInfo(source.projection);
  return { xKm: 0, yKm: 0, territory: info.territory, projection: source.projection, altRef: info.altRef };
}

/**
 * Dalle sous le point (lon, lat) : `coord` (sa dalle de 1 km, qui fixe le pays
 * et la zone JGD2011) ramenée au fichier qui sert le point au Japon, en NZ,
 * aux Pays-Bas et en Flandre. Synchrone pour le survol : null tant qu'un index
 * prioritaire charge (voir `loadFileTileIndex`), `coord` ailleurs ou hors
 * couverture.
 */
export function fileTileCoordAt(coord: TileCoord, lon: number, lat: number): TileCoord | null {
  let pending = false;
  for (const source of fileSourcesAt(coord, lon, lat)) {
    const finder = finders[source.territory];
    if (!finder) {
      void loadFinder(source.territory);
      pending = true;
      continue;
    }
    // Un index prioritaire charge encore : ne pas servir le suivant à sa place.
    if (pending) continue;
    const [east, north] = fromWgs84(lon, lat, source.projection);
    const bounds = finder(east, north, source.projection);
    if (bounds) return footprintTileCoord(sourceBaseCoord(coord, source), toFootprint(bounds));
  }
  return pending ? null : coord;
}

/** `fileTileCoordAt` en attendant les index si besoin. */
export async function resolveFileTileCoord(coord: TileCoord, lon: number, lat: number): Promise<TileCoord> {
  await loadFileTileIndex(coord, lon, lat);
  return fileTileCoordAt(coord, lon, lat) ?? coord;
}
