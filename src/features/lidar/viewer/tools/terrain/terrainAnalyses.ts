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

/** Le couvert du sol est lu jusqu'à cette distance autour des lignes de chute nominales (l'éventail s'élargit), m. */
const FALL_COVER_MARGIN_M = 60;

export interface TerrainAnalysisContext {
  field: TerrainField;
  pointPicker: PointCloudPicker;
  notify: (message: string, options?: { persistent?: boolean }) => void;
  /** La requête a été remplacée ou le viewer fermé : abandonner le résultat. */
  isStale: () => boolean;
}

/** Une analyse terminée : la mesure à afficher et le message qui l'annonce. */
export interface TerrainAnalysisResult {
  measurement: Measurement;
  message: string;
}

/**
 * Ligne de chute : trajectoires nominales d'abord (elles bornent le couvert du
 * sol lu dans le nuage de points), puis tout l'éventail sur ce couvert.
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
 * Exposition au terrain avalancheux (chaîne AutoATES, voir terrain/avalanche) :
 * le couvert de canopée est lu ici dans le nuage de points, le modèle tourne
 * dans un worker.
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
