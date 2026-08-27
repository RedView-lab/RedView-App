import type { TileCoord } from '../../types';
import { buildTileFileName } from '../../lib/coordConvert';
import type { ViewerStatusReporter } from '../runtime';

export const DEFAULT_MULTI_TILE_POINT_CAP = 8_000_000;
export const MIN_MULTI_TILE_POINT_CAP = 2_500_000;
export const MAX_MULTI_TILE_POINT_CAP = 12_000_000;
export const TILE_LOAD_COMPLETE_PROGRESS = 0.92;
export const SCENE_LOAD_START_PCT = 4;
export const SCENE_LOAD_END_PCT = 80;

export interface ViewerSceneLoadOptions {
  multiTilePointCap?: number;
  deviceMemoryGiB?: number;
  gpuInfo?: {
    vendor?: string;
    arch?: string;
    desc?: string;
  };
}

interface SceneTileProgressState {
  progress: number;
  detail: string;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundPointCap(value: number): number {
  return Math.max(MIN_MULTI_TILE_POINT_CAP, Math.round(value / 250_000) * 250_000);
}

export function getSceneLoadConcurrency(totalTiles: number): number {
  const hardwareThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const preferred = Math.max(2, Math.ceil(hardwareThreads / 4));
  return Math.max(1, Math.min(totalTiles, Math.min(4, preferred)));
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
    fileName: `${buildTileFileName(coord.xKm, coord.yKm, coord.projection, coord.altRef)}.copc.laz`,
    legacyFileName: `${buildTileFileName(coord.xKm, coord.yKm - 1, coord.projection, coord.altRef)}.copc.laz`,
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
    detail: `En attente ${coord.xKm}/${coord.yKm}`,
  }));
  let sceneFloor = 0;
  let sceneDetail = states[0]?.detail ?? 'Préparation de la scène';

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

export function resolveMultiTilePointCap(
  tileCount: number,
  options?: ViewerSceneLoadOptions,
): number {
  const explicitCap = options?.multiTilePointCap;
  if (Number.isFinite(explicitCap) && explicitCap && explicitCap > 0) {
    return Math.floor(explicitCap);
  }

  const rawMemoryGiB = options?.deviceMemoryGiB;
  const memoryGiB = Number.isFinite(rawMemoryGiB) && rawMemoryGiB
    ? clamp(rawMemoryGiB, 1, 16)
    : 4;

  const gpuInfo = options?.gpuInfo;
  const gpuHaystack = `${gpuInfo?.vendor ?? ''} ${gpuInfo?.arch ?? ''} ${gpuInfo?.desc ?? ''}`.toLowerCase();
  const isApple = gpuHaystack.includes('apple');
  const isDedicatedGpu = /nvidia|geforce|rtx|quadro|tesla|radeon\s+rx|radeon\s+pro|amd|arc\s|battlemage|alchemist/.test(gpuHaystack);
  const isIntegratedGpu = !isDedicatedGpu && /intel|iris|uhd|hd graphics|vega|apu|integrated/.test(gpuHaystack);

  let cap = memoryGiB <= 2
    ? 2_500_000
    : memoryGiB <= 4
      ? 4_500_000
      : memoryGiB < 8
        ? 6_500_000
        : DEFAULT_MULTI_TILE_POINT_CAP;

  const boostScale = tileCount >= 8 ? 0.25 : tileCount >= 6 ? 0.5 : tileCount >= 4 ? 0.75 : 1;
  if (isDedicatedGpu) {
    cap += (memoryGiB >= 8 ? 2_000_000 : 1_000_000) * boostScale;
  } else if (isApple) {
    cap += (memoryGiB >= 8 ? 750_000 : 250_000) * boostScale;
  } else if (isIntegratedGpu) {
    cap -= memoryGiB <= 4 ? 750_000 : 250_000;
  }

  if (tileCount >= 8) cap *= 0.7;
  else if (tileCount >= 6) cap *= 0.8;
  else if (tileCount >= 4) cap *= 0.9;

  return clamp(roundPointCap(cap), MIN_MULTI_TILE_POINT_CAP, MAX_MULTI_TILE_POINT_CAP);
}
