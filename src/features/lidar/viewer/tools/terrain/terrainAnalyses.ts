import { translateAppText as t } from '@/shared/i18n/config';
import { nextMeasurementId } from '../measurements/compute';
import type { Measurement } from '../measurements/types';
import type { PointCloudPicker } from '../picking/pointCloudPicker';
import type { ScenePick } from '../types';
import { CanopyGridBuilder } from './avalanche/canopy';
import type { AvalancheComputer } from './avalanche/client';
import { avalancheReadBounds, type AvalancheTerrainResult } from './avalanche/exposure';
import { computeFallLine, displayedFallScenario, fallLineBounds } from './fallLine';
import { CANOPY_SPACING_M, readFallCover } from './pointCloudReads';
import type { TerrainField } from './terrainField';

/** Ground cover is read this far around the nominal fall lines (the fan spreads), m. */
const FALL_COVER_MARGIN_M = 60;

export interface TerrainAnalysisContext {
  field: TerrainField;
  pointPicker: PointCloudPicker;
  notify: (message: string, options?: { persistent?: boolean }) => void;
  /** The request was superseded or the viewer closed: drop the result. */
  isStale: () => boolean;
}

/** A finished analysis: the measurement to show and the message announcing it. */
export interface TerrainAnalysisResult {
  measurement: Measurement;
  message: string;
}

/**
 * Fall line: nominal trajectories first (they bound the ground cover read
 * from the point cloud), then the whole fan over that cover.
 */
export async function runFallLineAnalysis(ctx: TerrainAnalysisContext, pick: ScenePick): Promise<TerrainAnalysisResult | null> {
  const { field, isStale } = ctx;
  const yieldToPage = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  ctx.notify(t('Calcul de la ligne de pente…'));
  const preview = await computeFallLine(field, pick.projX, pick.projY, { runs: 1 });
  if (isStale()) return null;
  if (!preview) {
    ctx.notify(t('Hors de la zone chargée'));
    return null;
  }
  const cover = await readFallCover(field, ctx.pointPicker, fallLineBounds(preview, FALL_COVER_MARGIN_M));
  if (isStale()) return null;
  const result = await computeFallLine(field, pick.projX, pick.projY, { cover, yieldToPage });
  if (isStale() || !result) return null;
  return {
    measurement: { id: nextMeasurementId(), kind: 'fallLine', origin: pick, result, scenario: displayedFallScenario(result) },
    message: result.scenarios.every((s) => s.end === 'noSlide')
      ? t('Pente trop faible : rien ne glisse ici')
      : t('Ligne de pente calculée'),
  };
}

/**
 * Avalanche terrain exposure (AutoATES chain, see terrain/avalanche): the
 * canopy cover is read from the point cloud here, the model runs in a worker.
 */
export async function runAvalancheAnalysis(
  ctx: TerrainAnalysisContext,
  avalanche: AvalancheComputer,
  pick: ScenePick,
): Promise<TerrainAnalysisResult | null> {
  const { field, isStale } = ctx;
  const grid = field.getAvalancheGrid();
  ctx.notify(t('Calcul de l’exposition avalanche…'), { persistent: true });
  const canopy = new CanopyGridBuilder(field, grid);
  const bounds = avalancheReadBounds(grid, pick.projX, pick.projY);
  let forestRead = true;
  try {
    await ctx.pointPicker.forEachPointToSpacing(bounds, CANOPY_SPACING_M, (x, y, z, cls) => canopy.add(x, y, z, cls));
  } catch (error) {
    console.warn('[LiDAR tools] Canopy read failed:', error);
    forestRead = false;
  }
  if (isStale()) return null;
  const cover = forestRead ? canopy.finish() : null;
  let result: AvalancheTerrainResult | null;
  try {
    result = await avalanche.compute(`${grid.width}x${grid.height}@${grid.originX},${grid.originY}/${grid.cell}`, {
      grid: {
        width: grid.width,
        height: grid.height,
        cell: grid.cell,
        originX: grid.originX,
        originY: grid.originY,
        altitude: grid.altitude,
        slopeDeg: grid.slopeDeg,
      },
      canopyPct: cover?.canopyPct ?? null,
      projX: pick.projX,
      projY: pick.projY,
    });
  } catch (error) {
    if (isStale()) return null;
    console.warn('[LiDAR tools] Avalanche exposure failed:', error);
    ctx.notify(t('Calcul de l’exposition avalanche impossible'));
    return null;
  }
  if (isStale()) return null;
  if (!result) {
    ctx.notify(t('Hors de la zone chargée'));
    return null;
  }
  return {
    measurement: { id: nextMeasurementId(), kind: 'avalanche', origin: pick, result },
    message: t('Exposition avalanche calculée'),
  };
}
