import { getTileInfo, kmTileCoord, parseTileFootprint, tileCoordFileName, tileFootprintSuffix } from '../../lib/coordConvert';
import { translateAppText } from '@/shared/i18n/config';
import type { DetectedCrs, AltitudeRef, TileCoord, TileFootprint } from '../../types';
import { MAX_VIEWER_SCENE_TILES } from '../../lib/viewerUrl';
import { parseViewerEngineParam, VIEWER_ENGINE_PARAM, type ViewerEngineRequest } from './viewerEngine';

function buildPanelTileLabel(x: number, y: number, projection: DetectedCrs): string {
  return translateAppText('Tuile {{x}}/{{y}} ({{projection}})', { x, y, projection });
}

function tileCoordKey(coord: Pick<TileCoord, 'xKm' | 'yKm' | 'projection' | 'altRef' | 'footprint'>): string {
  return `${coord.xKm}_${coord.yKm}_${coord.projection}_${coord.altRef}${tileFootprintSuffix(coord)}`;
}

function parseSceneTileCoords(params: URLSearchParams, primaryTile: TileCoord): TileCoord[] {
  const tiles: TileCoord[] = [primaryTile];
  const seen = new Set<string>([tileCoordKey(primaryTile)]);

  const appendTile = (xKm: number, yKm: number, footprint?: TileFootprint | null) => {
    if (!Number.isFinite(xKm) || !Number.isFinite(yKm)) return;
    if (tiles.length >= MAX_VIEWER_SCENE_TILES) return;

    const base = kmTileCoord({ ...primaryTile, xKm, yKm });
    const coord: TileCoord = footprint ? { ...base, footprint } : base;
    const key = tileCoordKey(coord);
    if (seen.has(key)) return;
    seen.add(key);
    tiles.push(coord);
  };

  for (const rawTile of params.getAll('tile')) {
    const [rawX, rawY, ...rawFootprint] = rawTile.split(',');
    const footprint = rawFootprint.length > 0 ? parseTileFootprint(rawFootprint.join(',')) : null;
    if (rawFootprint.length > 0 && !footprint) continue;
    appendTile(parseInt(rawX || '', 10), parseInt(rawY || '', 10), footprint);
  }

  const legacySecondaryXKm = parseInt(params.get('sx') || '', 10);
  const legacySecondaryYKm = parseInt(params.get('sy') || '', 10);
  appendTile(legacySecondaryXKm, legacySecondaryYKm);

  return tiles;
}

const ALLOWED_BASE_CRS: ReadonlySet<string> = new Set<DetectedCrs>([
  'LAMB93',
  'RGR92UTM40S',
  'CH1903_LV95',
  'NZTM2000',
  'RD_NEW',
  'BL72',
]);
const JGD2011_ZONE_CRS_RE = /^JGD2011_ZONE_(0[1-9]|1[0-9])$/;
const ALLOWED_ALT_REFS: ReadonlySet<string> = new Set<AltitudeRef>([
  'IGN69',
  'IGN78',
  'REUN89',
  'LN02',
  'NZVD2016',
  'TP',
  'NAP',
  'TAW',
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
  /** `?engine=` (voir viewerEngine.ts). */
  engine: ViewerEngineRequest;
  /**
   * `?bench=orbit` : trajet de caméra scripté qui rapporte la vraie cadence d'images (voir perf/viewerBench) ;
   * `?bench=shots` : poses fixes posées par un script de capture (`window.__rvLidarShots`).
   */
  bench: 'orbit' | 'shots' | null;
  /** `?budget=<points>` : budget de points fixe (benchs comparant des variantes à charge égale), sinon null. */
  pinnedBudget: number | null;
  /**
   * Qualité pendant que la caméra bouge, pour les benchs A/B : `?mscale=<0.3–1>`
   * remplace l'échelle de rendu de la plateforme (null : défaut de la plateforme),
   * `?msquare=0` garde des sprites ronds.
   */
  motionQuality: { scale: number | null; squares: boolean };
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
  const engine = parseViewerEngineParam(params.get(VIEWER_ENGINE_PARAM));
  const rawBench = params.get('bench');
  const bench = rawBench === 'orbit' || rawBench === 'shots' ? rawBench : null;
  const rawBudget = Number(params.get('budget'));
  const pinnedBudget = Number.isFinite(rawBudget) && rawBudget >= 10_000 ? Math.min(Math.round(rawBudget), 100_000_000) : null;
  const rawMotionScale = Number(params.get('mscale'));
  const motionQuality = {
    scale: params.has('mscale') && Number.isFinite(rawMotionScale) ? Math.min(1, Math.max(0.3, rawMotionScale)) : null,
    squares: params.get('msquare') !== '0',
  };

  if (!Number.isFinite(xKm) || !Number.isFinite(yKm) || !parsedCrs || !parsedAltRef) {
    throw new Error(translateAppText('Paramètres invalides. URL attendue : ?x=1003&y=6547&crs=LAMB93&alt=IGN69'));
  }
  const crs: DetectedCrs = parsedCrs;
  const altRef: AltitudeRef = parsedAltRef;

  const footprint = parseTileFootprint(params.get('fp'));
  const tileInfo = getTileInfo(crs);
  const viewerTileCoord: TileCoord = {
    xKm,
    yKm,
    territory: tileInfo.territory,
    projection: crs,
    altRef,
    ...(footprint ? { footprint } : {}),
  };
  const tileFileName = tileCoordFileName(viewerTileCoord);
  const legacyTileFileName = tileCoordFileName({ ...viewerTileCoord, yKm: yKm - 1 });
  const sceneTileCoords = parseSceneTileCoords(params, viewerTileCoord);
  const panelTileLabel = sceneTileCoords
    .map((coord) => buildPanelTileLabel(coord.xKm, coord.yKm, coord.projection))
    .join(' + ');

  return {
    xKm,
    yKm,
    crs,
    altRef,
    engine,
    bench,
    pinnedBudget,
    motionQuality,
    tileFileName,
    legacyTileFileName,
    viewerTileCoord,
    sceneTileCoords,
    panelTileLabel,
  };
}
