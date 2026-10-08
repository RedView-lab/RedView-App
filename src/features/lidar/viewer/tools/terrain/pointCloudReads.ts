import type { PointCloudPicker } from '../picking/pointCloudPicker';
import { CanopyGridBuilder } from './avalanche/canopy';
import { FallCoverBuilder, type CoverBounds, type FallCover } from './fallCover';
import type { AnalysisGrid, TerrainField } from './terrainField';

/** Espacement d'octree auquel le couvert de canopée est lu (couronnes vues en colonnes de 2 m), m. */
export const CANOPY_SPACING_M = 2;

/**
 * Couvert de canopée (0–1) de toute la scène sur une grille de nœuds d'environ
 * `cellM` d'espacement sur l'emprise du modèle de sol (entrée du modèle de
 * neige, lu comme la forêt des avalanches : retours de haute végétation à 3 m
 * au-dessus du sol). `null` quand le nuage ne porte pas de classification du sol.
 */
export async function readSceneCanopy(
  field: TerrainField,
  pointPicker: PointCloudPicker,
  cellM: number,
): Promise<{ data: Float32Array; width: number; height: number } | null> {
  const width = Math.max(2, Math.round((field.maxX - field.minX) / cellM) + 1);
  const cell = (field.maxX - field.minX) / (width - 1);
  const height = Math.max(2, Math.round((field.maxY - field.minY) / cell) + 1);
  const grid: AnalysisGrid = {
    width, height, cell, originX: field.minX, originY: field.minY,
    altitude: new Float32Array(0), slopeDeg: new Float32Array(0),
  };
  const builder = new CanopyGridBuilder(field, grid);
  await pointPicker.forEachPointToSpacing(builder.bounds, CANOPY_SPACING_M, (x, y, z, cls) => builder.add(x, y, z, cls));
  const cover = builder.finish();
  if (!cover) return null;
  return { data: Float32Array.from(cover.canopyPct, (v) => (Number.isFinite(v) ? v / 100 : 0)), width, height };
}

/** Arbres, bâtiments et eau autour d'une ligne de chute, d'après les retours LiDAR dessinés ; `null` en cas d'échec. */
export async function readFallCover(
  field: TerrainField,
  pointPicker: PointCloudPicker,
  bounds: CoverBounds,
): Promise<FallCover | null> {
  const clipped: CoverBounds = {
    minX: Math.max(field.minX, bounds.minX),
    minY: Math.max(field.minY, bounds.minY),
    maxX: Math.min(field.maxX, bounds.maxX),
    maxY: Math.min(field.maxY, bounds.maxY),
  };
  const builder = new FallCoverBuilder(field, clipped);
  try {
    // Repère de rendu : x est, y haut, z = −nord.
    await pointPicker.forEachPointInBox(
      {
        minX: clipped.minX - field.centerX,
        maxX: clipped.maxX - field.centerX,
        minZ: field.centerY - clipped.maxY,
        maxZ: field.centerY - clipped.minY,
      },
      (x, y, z, cls) => builder.add(x + field.centerX, field.centerY - z, y + field.centerZ, cls),
    );
  } catch (error) {
    console.warn('[LiDAR tools] Ground cover read failed:', error);
    return null;
  }
  return builder.finish();
}
