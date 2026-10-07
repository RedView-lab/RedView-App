import { trackAnalyticsEvent } from '@/shared/lib/analytics';
import type { CanopyGrid } from '@/features/snow';
import type { DetectedCrs, PointCloudData } from '../../types';
import type { TerrainCache } from '../../lib/storage';
import type { LidarRenderer } from '../renderer/sceneRenderer';
import type { SnowModeKey } from '../panel/controller';

const SNOW_MODES: Record<SnowModeKey, 0 | 1 | 2> = {
  off: 0,
  cover: 1,
  thickness: 2,
};

/** Canopy grid spacing read for the snow model, m. */
const SNOW_CANOPY_CELL_M = 10;

export interface SnowSceneContext {
  renderer: LidarRenderer | null;
  pointCloud: Pick<PointCloudData, 'bounds'>;
  terrainMesh: TerrainCache;
  crs: DetectedCrs;
  /** Scene centre in the CRS; the height grid stores altitudes minus `cz`. */
  cx: number;
  cy: number;
  cz: number;
  /** Canopy cover of the scene from the point cloud (forest snow interception). */
  readCanopy?: (cellM: number) => Promise<CanopyGrid | null>;
  onProgressState: (loading: boolean) => void;
  requestRender: () => void;
}

export class ViewerSnowController {
  private snowMode: SnowModeKey = 'off';
  private snowFieldLoaded = false;
  private snowLoading = false;

  getMode(): SnowModeKey {
    return this.snowMode;
  }

  async ensureSnowFieldLoaded(ctx: SnowSceneContext): Promise<boolean> {
    const { renderer, pointCloud, terrainMesh } = ctx;
    if (!renderer || this.snowLoading || this.snowFieldLoaded) return true;
    this.snowLoading = true;
    ctx.onProgressState(true);
    try {
      const { runSnowPipeline } = await import('@/features/snow');
      let canopy: CanopyGrid | null = null;
      try {
        canopy = (await ctx.readCanopy?.(SNOW_CANOPY_CELL_M)) ?? null;
      } catch (err) {
        console.warn('[Viewer] Snow canopy read failed, open terrain assumed:', err);
      }
      const field = await runSnowPipeline(
        {
          data: terrainMesh.heightGrid,
          width: terrainMesh.gridWidth,
          height: terrainMesh.gridHeight,
          bounds: pointCloud.bounds,
          crs: ctx.crs,
          altitudeOffsetM: ctx.cz,
          canopy,
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
        originX: pointCloud.bounds.minX - ctx.cx,
        originZ: -(pointCloud.bounds.maxY - ctx.cy),
        scaleX: pointCloud.bounds.maxX - pointCloud.bounds.minX,
        scaleZ: pointCloud.bounds.maxY - pointCloud.bounds.minY,
      });
      ctx.requestRender();
      this.snowFieldLoaded = true;
      const d = field.diagnostics;
      const used = d.assimilation.stations.filter((s) => s.used).length;
      console.log(
        `[Viewer] Snow loaded: avg=${field.stats.meanCm.toFixed(0)}cm, ` +
        `max=${field.stats.maxCm.toFixed(0)}cm, cov=${field.stats.coveragePct.toFixed(1)}%, ` +
        `${field.stats.elapsedMs.toFixed(0)}ms (${field.arome.source} ${field.arome.timestamp}; ` +
        `${used} stations, k=${d.assimilation.precipitationFactor.toFixed(2)}, ` +
        `BRA ${d.assimilation.braUsed ? 'yes' : 'no'}, wind ${d.wind.source} ${d.wind.redistributedPct.toFixed(0)}%, ` +
        `avalanches ${d.gravity.movedPct.toFixed(0)}%, melt ${d.melt.flatMeltCm.toFixed(0)}cm)`,
        field.sources,
      );
      return true;
    } catch (err) {
      console.error('[Viewer] Snow fetch failed:', err);
      renderer.setSnowMode(0);
      ctx.requestRender();
      return false;
    } finally {
      this.snowLoading = false;
      ctx.onProgressState(false);
    }
  }

  async handleSnowModeChange(
    nextMode: SnowModeKey,
    ctx: SnowSceneContext,
    onModeUpdate: (mode: SnowModeKey) => void,
  ): Promise<void> {
    if (!ctx.renderer || this.snowLoading) return;
    if (nextMode !== 'off') {
      const ready = await this.ensureSnowFieldLoaded(ctx);
      if (!ready) {
        this.snowMode = 'off';
        onModeUpdate('off');
        return;
      }
    }
    if (nextMode !== 'off' && this.snowMode === 'off') trackAnalyticsEvent({ name: 'snow_mode_enabled', data: { mode: nextMode } });
    this.snowMode = nextMode;
    ctx.renderer.setSnowMode(SNOW_MODES[nextMode]);
    onModeUpdate(nextMode);
    ctx.requestRender();
  }
}
