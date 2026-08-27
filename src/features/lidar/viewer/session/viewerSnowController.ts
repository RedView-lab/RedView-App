import type { DetectedCrs, PointCloudData } from '../../types';
import type { TerrainCache } from '../../lib/storage';
import type { LidarRenderer } from '../renderer';
import type { SnowModeKey } from '../panel/controller';

const SNOW_MODES: Record<SnowModeKey, 0 | 1 | 2> = {
  off: 0,
  cover: 1,
  thickness: 2,
};

export class ViewerSnowController {
  private snowMode: SnowModeKey = 'off';
  private snowFieldLoaded = false;
  private snowLoading = false;

  getMode(): SnowModeKey {
    return this.snowMode;
  }

  async ensureSnowFieldLoaded(
    renderer: LidarRenderer | null,
    pointCloud: PointCloudData,
    terrainMesh: TerrainCache,
    crs: DetectedCrs,
    cx: number,
    cy: number,
    onProgressState: (loading: boolean) => void,
    requestRender: () => void,
  ): Promise<boolean> {
    if (!renderer || this.snowLoading || this.snowFieldLoaded) return true;
    this.snowLoading = true;
    onProgressState(true);
    try {
      const { runSnowPipeline } = await import('@/features/snow');
      const field = await runSnowPipeline(
        {
          data: terrainMesh.heightGrid,
          width: terrainMesh.gridWidth,
          height: terrainMesh.gridHeight,
          bounds: pointCloud.bounds,
          crs,
        },
        { progress: () => undefined },
      );
      const flipped = new Float32Array(field.data.length);
      for (let y = 0; y < field.height; y++) {
        const srcRow = (field.height - 1 - y) * field.width;
        const dstRow = y * field.width;
        for (let x = 0; x < field.width; x++) {
          flipped[dstRow + x] = field.data[srcRow + x]!;
        }
      }
      renderer.setSnow({
        data: flipped,
        width: field.width,
        height: field.height,
        originX: pointCloud.bounds.minX - cx,
        originZ: -(pointCloud.bounds.maxY - cy),
        scaleX: pointCloud.bounds.maxX - pointCloud.bounds.minX,
        scaleZ: pointCloud.bounds.maxY - pointCloud.bounds.minY,
      });
      requestRender();
      this.snowFieldLoaded = true;
      console.log(
        `[Viewer] Snow loaded: avg=${field.stats.meanCm.toFixed(0)}cm, ` +
        `max=${field.stats.maxCm.toFixed(0)}cm, cov=${field.stats.coveragePct.toFixed(1)}%, ` +
        `${field.stats.elapsedMs.toFixed(0)}ms (AROME ${field.arome.timestamp})`,
      );
      return true;
    } catch (err) {
      console.error('[Viewer] Snow fetch failed:', err);
      renderer.setSnowMode(0);
      requestRender();
      return false;
    } finally {
      this.snowLoading = false;
      onProgressState(false);
    }
  }

  async handleSnowModeChange(
    nextMode: SnowModeKey,
    renderer: LidarRenderer | null,
    pointCloud: PointCloudData,
    terrainMesh: TerrainCache,
    crs: DetectedCrs,
    cx: number,
    cy: number,
    onProgressState: (loading: boolean) => void,
    onModeUpdate: (mode: SnowModeKey) => void,
    requestRender: () => void,
  ): Promise<void> {
    if (!renderer || this.snowLoading) return;
    if (nextMode !== 'off') {
      const ready = await this.ensureSnowFieldLoaded(
        renderer,
        pointCloud,
        terrainMesh,
        crs,
        cx,
        cy,
        onProgressState,
        requestRender,
      );
      if (!ready) {
        this.snowMode = 'off';
        onModeUpdate('off');
        return;
      }
    }
    this.snowMode = nextMode;
    renderer.setSnowMode(SNOW_MODES[nextMode]);
    onModeUpdate(nextMode);
    requestRender();
  }
}
