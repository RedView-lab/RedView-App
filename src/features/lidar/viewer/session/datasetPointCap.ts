import type { TileCoord } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { tileCoordFileName } from '../../lib/coordConvert';
import type { ViewerStatusReporter } from '../runtime';

const TILE_LOAD_COMPLETE_PROGRESS = 0.92;
const SCENE_LOAD_START_PCT = 4;
const SCENE_LOAD_END_PCT = 80;

export interface ViewerSceneLoadOptions {
  deviceMemoryGiB?: number;
}

interface SceneTileProgressState {
  progress: number;
  detail: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Tuiles traitées à la fois. Une première visite garde toute une tuile décodée
 * en mémoire (~18 o/point, 35 M points pour une tuile IGN dense) pendant la
 * construction de son cache LOD : les machines à peu de mémoire prennent donc
 * les tuiles une par une ; les tuiles en cache ne coûtent qu'une lecture
 * d'en-tête dans tous les cas.
 */
export function getSceneLoadConcurrency(totalTiles: number, deviceMemoryGiB?: number): number {
  const hardwareThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const memoryCap = deviceMemoryGiB !== undefined && deviceMemoryGiB <= 4 ? 1 : deviceMemoryGiB !== undefined && deviceMemoryGiB < 8 ? 2 : 3;
  const preferred = Math.max(1, Math.ceil(hardwareThreads / 4));
  return Math.max(1, Math.min(totalTiles, memoryCap, preferred));
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runWorker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

export function buildTileFileCandidates(coord: TileCoord): { fileName: string; legacyFileName: string } {
  return {
    fileName: tileCoordFileName(coord),
    legacyFileName: tileCoordFileName({ ...coord, yKm: coord.yKm - 1 }),
  };
}

export function createSceneProgressReporter(
  tileCoords: TileCoord[],
  setStatus: ViewerStatusReporter,
): {
  updateTileProgress: (index: number, detail: string, progress: number) => void;
  updateSceneProgress: (detail: string, progress: number) => void;
} {
  const states: SceneTileProgressState[] = tileCoords.map((coord) => ({
    progress: 0,
    detail: translateAppText('En attente {{x}}/{{y}}', { x: coord.xKm, y: coord.yKm }),
  }));
  let sceneFloor = 0;
  let sceneDetail = states[0]?.detail ?? translateAppText('Préparation de la scène');

  const emit = (overrideDetail?: string) => {
    const averageTileProgress = states.length > 0
      ? states.reduce((sum, state) => sum + state.progress, 0) / states.length
      : 1;
    const normalized = clamp(Math.max(sceneFloor, averageTileProgress), 0, 1);
    const detail = overrideDetail
      ?? (sceneFloor > averageTileProgress ? sceneDetail : undefined)
      ?? states
        .slice()
        .sort((left, right) => right.progress - left.progress)[0]?.detail
      ?? sceneDetail;
    const pct = SCENE_LOAD_START_PCT + normalized * (SCENE_LOAD_END_PCT - SCENE_LOAD_START_PCT);
    setStatus(detail, pct);
  };

  return {
    updateTileProgress(index: number, detail: string, progress: number) {
      const state = states[index];
      if (!state) return;
      state.detail = detail;
      state.progress = Math.max(state.progress, clamp(progress, 0, TILE_LOAD_COMPLETE_PROGRESS));
      emit();
    },
    updateSceneProgress(detail: string, progress: number) {
      sceneDetail = detail;
      sceneFloor = Math.max(sceneFloor, clamp(progress, 0, 1));
      emit(detail);
    },
  };
}
