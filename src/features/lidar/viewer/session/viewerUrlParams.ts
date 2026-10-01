import { buildTileFileName, getTileInfo } from '../../lib/coordConvert';
import type { DetectedCrs, AltitudeRef, TileCoord } from '../../types';
import { MAX_VIEWER_SCENE_TILES } from '../../lib/viewerUrl';

export function buildPanelTileLabel(x: number, y: number, projection: DetectedCrs): string {
  return `Tuile ${x}/${y} (${projection})`;
}

export function tileCoordKey(coord: Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef'>): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}`;
}

export function parseSceneTileCoords(params: URLSearchParams, primaryTile: TileCoord): TileCoord[] {
  const tiles: TileCoord[] = [primaryTile];
  const seen = new Set<string>([tileCoordKey(primaryTile)]);

  const appendTile = (xKm: number, yKm: number) => {
    if (!Number.isFinite(xKm) || !Number.isFinite(yKm)) return;
    if (tiles.length >= MAX_VIEWER_SCENE_TILES) return;

    const coord: TileCoord = {
      ...primaryTile,
      xKm,
      yKm,
    };
    const key = tileCoordKey(coord);
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push(coord);
  };

  for (const rawTile of params.getAll('tile')) {
    const [rawX, rawY] = rawTile.split(',', 2);
    appendTile(parseInt(rawX || '', 10), parseInt(rawY || '', 10));
  }

  const legacySecondaryXKm = parseInt(params.get('sx') || '', 10);
  const legacySecondaryYKm = parseInt(params.get('sy') || '', 10);
  appendTile(legacySecondaryXKm, legacySecondaryYKm);

  return tiles;
}

export function computeSceneBudgetScale(tileCount: number, totalPoints: number, pointChunkCapacity: number): number {
  if (tileCount <= 1) return 1.0;

  const tilePressureScale = 1 / (1 + (tileCount - 1) * 0.16);
  const chunkPressureRatio = totalPoints / Math.max(pointChunkCapacity * 1.5, 1);
  const chunkPressureScale = chunkPressureRatio <= 1
    ? 1.0
    : 1 / (1 + Math.log2(chunkPressureRatio) * 0.18);

  return Math.max(0.35, Math.min(1.0, tilePressureScale * chunkPressureScale));
}

const ALLOWED_BASE_CRS: ReadonlySet<string> = new Set<DetectedCrs>([
  'LAMB93',
  'RGR92UTM40S',
  'CH1903_LV95',
  'NZTM2000',
]);
const JGD2011_ZONE_CRS_RE = /^JGD2011_ZONE_(0[1-9]|1[0-9])$/;
const ALLOWED_ALT_REFS: ReadonlySet<string> = new Set<AltitudeRef>([
  'IGN69',
  'IGN78',
  'REUN89',
  'LN02',
  'NZVD2016',
  'TP',
]);

/** Valide `crs` contre la liste des systèmes supportés (pas de simple cast d'un paramètre d'URL). */
function parseCrsParam(raw: string | null): DetectedCrs | null {
  const value = raw || 'LAMB93';
  if (ALLOWED_BASE_CRS.has(value) || JGD2011_ZONE_CRS_RE.test(value)) return value as DetectedCrs;
  return null;
}

function parseAltRefParam(raw: string | null): AltitudeRef | null {
  const value = raw || 'IGN69';
  return ALLOWED_ALT_REFS.has(value) ? (value as AltitudeRef) : null;
}

export function parseViewerParamsFromUrl(): {
  xKm: number;
  yKm: number;
  crs: DetectedCrs;
  altRef: AltitudeRef;
  forceWebGL: boolean;
  tileFileName: string;
  legacyTileFileName: string;
  viewerTileCoord: TileCoord;
  sceneTileCoords: TileCoord[];
  panelTileLabel: string;
} {
  const params = new URLSearchParams(window.location.search);
  const xKm = parseInt(params.get('x') || '', 10);
  const yKm = parseInt(params.get('y') || '', 10);
  const parsedCrs = parseCrsParam(params.get('crs'));
  const parsedAltRef = parseAltRefParam(params.get('alt'));
  const forceWebGL = params.get('engine') === 'webgl';

  if (!Number.isFinite(xKm) || !Number.isFinite(yKm) || !parsedCrs || !parsedAltRef) {
    throw new Error('Paramètres invalides. URL: ?x=1003&y=6547&crs=LAMB93&alt=IGN69');
  }
  const crs: DetectedCrs = parsedCrs;
  const altRef: AltitudeRef = parsedAltRef;

  const tileFileName = `${buildTileFileName(xKm, yKm, crs, altRef)}.copc.laz`;
  const legacyTileFileName = `${buildTileFileName(xKm, yKm - 1, crs, altRef)}.copc.laz`;
  const tileInfo = getTileInfo(crs);
  const viewerTileCoord = {
    xKm,
    yKm,
    territory: tileInfo.territory,
    projection: crs,
    altRef,
  } as TileCoord;
  const sceneTileCoords = parseSceneTileCoords(params, viewerTileCoord);
  const panelTileLabel = sceneTileCoords
    .map((coord) => buildPanelTileLabel(coord.xKm, coord.yKm, coord.projection))
    .join(' + ');

  return {
    xKm,
    yKm,
    crs,
    altRef,
    forceWebGL,
    tileFileName,
    legacyTileFileName,
    viewerTileCoord,
    sceneTileCoords,
    panelTileLabel,
  };
}
