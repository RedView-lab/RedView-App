import type { TileCoord } from '../types/geometry';
import type { PointCloudData } from '../types/tile';
import type { DownloadProgress } from '../types/events';
import type { TileStateManager } from './tile-state';
import { buildTileFileName } from '../processing/coord-transform';
import { downloadTile } from '../api/ign-download';
import { processLazAsync } from '../processing/process-async';
import { estimateNormalsAsync } from '../processing/normals-async';
import { loadColorizedData, saveColorizedData } from '../storage/colorized-store';
import { loadNormalsData, saveNormalsData } from '../storage/normals-store';

export interface ProcessedTile {
  coord: TileCoord;
  pointCloud: PointCloudData;
  normals: Float32Array;
}

export async function processTile(
  coord: TileCoord,
  state: TileStateManager,
): Promise<ProcessedTile> {
  const fileName = buildTileFileName(coord) + '.copc.laz';

  const cachedColorized = await loadColorizedData(fileName);
  if (cachedColorized) {
    state.set(coord, 'computing-normals');
    const cachedNormals = await loadNormalsData(fileName, cachedColorized.count);
    const normals = cachedNormals ?? await estimateNormalsAsync(cachedColorized.positions, cachedColorized.count);
    if (!cachedNormals) {
      await saveNormalsData(fileName, normals).catch(() => {});
    }
    state.set(coord, 'rendering');
    return { coord, pointCloud: cachedColorized, normals };
  }

  state.set(coord, 'downloading');
  const buffer = await downloadTile(coord, (p: DownloadProgress) => {
    state.set(coord, 'downloading', p);
  });

  state.set(coord, 'parsing');
  const colorized = await processLazAsync(buffer, (percent, phase) => {
    const tileStatus = phase === 'colorizing' ? 'colorizing' as const : 'parsing' as const;
    state.set(coord, tileStatus, {
      tileCoord: coord,
      bytesDownloaded: 0,
      totalBytes: 0,
      phase: tileStatus,
      percent,
    });
  });

  await saveColorizedData(fileName, colorized).catch(() => {});

  state.set(coord, 'computing-normals');
  const normals = await estimateNormalsAsync(colorized.positions, colorized.count);
  await saveNormalsData(fileName, normals).catch(() => {});

  state.set(coord, 'rendering');
  return { coord, pointCloud: colorized, normals };
}
