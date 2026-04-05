import type { TileCoord } from '../types/geometry';
import type { PointCloudData } from '../types/tile';
import type { DownloadProgress } from '../types/events';
import type { TileStateManager } from './tile-state';
import { buildTileFileName } from '../processing/coord-transform';
import { downloadTile } from '../api/ign-download';
import { parseLazFile } from '../processing/laz-parser';
import { colorizePointCloud } from '../processing/colorizer';
import { estimateNormals } from '../processing/normal-estimator';
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
    const normals = cachedNormals ?? estimateNormals(cachedColorized.positions, cachedColorized.count);
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
  const raw = await parseLazFile(buffer);

  state.set(coord, 'colorizing');
  const colorized = await colorizePointCloud(raw, (percent) => {
    state.set(coord, 'colorizing', {
      tileCoord: coord,
      bytesDownloaded: 0,
      totalBytes: 0,
      phase: 'colorizing',
      percent,
    });
  });

  await saveColorizedData(fileName, colorized).catch(() => {});

  state.set(coord, 'computing-normals');
  const normals = estimateNormals(colorized.positions, colorized.count);
  await saveNormalsData(fileName, normals).catch(() => {});

  state.set(coord, 'rendering');
  return { coord, pointCloud: colorized, normals };
}
