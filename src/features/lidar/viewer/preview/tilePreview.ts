import { getTileBounds } from '../../lib/coordConvert';
import type { TileCoord, PointCloudBounds } from '../../types';
import type { TerrainCache } from '../../lib/storage';

export interface PreviewMeshBuffers {
  vertices: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sampleSceneHeight(
  x: number,
  y: number,
  sceneBounds: PointCloudBounds,
  terrainMesh: TerrainCache,
): number {
  const rangeX = Math.max(1, sceneBounds.maxX - sceneBounds.minX);
  const rangeY = Math.max(1, sceneBounds.maxY - sceneBounds.minY);
  const u = clamp((x - sceneBounds.minX) / rangeX, 0, 1);
  const v = clamp((y - sceneBounds.minY) / rangeY, 0, 1);

  const sampleX = u * (terrainMesh.gridWidth - 1);
  const sampleY = v * (terrainMesh.gridHeight - 1);
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const x1 = Math.min(terrainMesh.gridWidth - 1, x0 + 1);
  const y1 = Math.min(terrainMesh.gridHeight - 1, y0 + 1);
  const tx = sampleX - x0;
  const ty = sampleY - y0;

  const h00 = terrainMesh.heightGrid[y0 * terrainMesh.gridWidth + x0];
  const h10 = terrainMesh.heightGrid[y0 * terrainMesh.gridWidth + x1];
  const h01 = terrainMesh.heightGrid[y1 * terrainMesh.gridWidth + x0];
  const h11 = terrainMesh.heightGrid[y1 * terrainMesh.gridWidth + x1];
  const top = h00 + (h10 - h00) * tx;
  const bottom = h01 + (h11 - h01) * tx;
  return top + (bottom - top) * ty;
}

function pushFace(
  vertices: number[],
  colors: number[],
  indices: number[],
  faceVertices: Array<[number, number, number]>,
  normal: [number, number, number],
  color: [number, number, number, number],
): void {
  const start = vertices.length / 6;
  for (const [x, y, z] of faceVertices) {
    vertices.push(x, y, z, normal[0], normal[1], normal[2]);
    colors.push(color[0], color[1], color[2], color[3]);
  }
  indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
}

export function buildTilePreviewMesh(
  coord: TileCoord,
  sceneBounds: PointCloudBounds,
  terrainMesh: TerrainCache,
): PreviewMeshBuffers {
  const tileBounds = getTileBounds(coord);
  const centerX = (sceneBounds.minX + sceneBounds.maxX) / 2;
  const centerY = (sceneBounds.minY + sceneBounds.maxY) / 2;
  const centerZ = (sceneBounds.minZ + sceneBounds.maxZ) / 2;
  const samplePoints: Array<[number, number]> = [
    [tileBounds.minX, tileBounds.minY],
    [tileBounds.maxX, tileBounds.minY],
    [tileBounds.maxX, tileBounds.maxY],
    [tileBounds.minX, tileBounds.maxY],
    [(tileBounds.minX + tileBounds.maxX) / 2, (tileBounds.minY + tileBounds.maxY) / 2],
  ];

  // If heightGrid contains absolute altitudes (e.g. WebGL raw heights rather than WebGPU centered heights),
  // subtract centerZ to place it correctly in renderer space.
  const isAbsoluteHeight = terrainMesh.heightGrid.some(
    (h) => Number.isFinite(h) && h >= sceneBounds.minZ - 50 && sceneBounds.minZ > 50,
  );
  const sampledHeights = samplePoints.map(([x, y]) => {
    const raw = sampleSceneHeight(x, y, sceneBounds, terrainMesh);
    return isAbsoluteHeight ? raw - centerZ : raw;
  });
  const baseHeight = Math.max(...sampledHeights) + 6;
  const thickness = 20;
  const topY = baseHeight + thickness;
  const bottomY = baseHeight;
  const inset = 18;

  const west = tileBounds.minX + inset - centerX;
  const east = tileBounds.maxX - inset - centerX;
  const north = -(tileBounds.maxY - inset - centerY);
  const south = -(tileBounds.minY + inset - centerY);

  const vertices: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const faceColor: [number, number, number, number] = [220, 20, 20, 172];

  pushFace(vertices, colors, indices, [
    [west, topY, north],
    [east, topY, north],
    [east, topY, south],
    [west, topY, south],
  ], [0, 1, 0], faceColor);

  pushFace(vertices, colors, indices, [
    [west, bottomY, south],
    [east, bottomY, south],
    [east, bottomY, north],
    [west, bottomY, north],
  ], [0, -1, 0], faceColor);

  pushFace(vertices, colors, indices, [
    [west, bottomY, north],
    [east, bottomY, north],
    [east, topY, north],
    [west, topY, north],
  ], [0, 0, -1], faceColor);

  pushFace(vertices, colors, indices, [
    [west, bottomY, south],
    [west, topY, south],
    [east, topY, south],
    [east, bottomY, south],
  ], [0, 0, 1], faceColor);

  pushFace(vertices, colors, indices, [
    [east, bottomY, north],
    [east, bottomY, south],
    [east, topY, south],
    [east, topY, north],
  ], [1, 0, 0], faceColor);

  pushFace(vertices, colors, indices, [
    [west, bottomY, south],
    [west, bottomY, north],
    [west, topY, north],
    [west, topY, south],
  ], [-1, 0, 0], faceColor);

  return {
    vertices: new Float32Array(vertices),
    colors: new Uint8Array(colors),
    indices: new Uint32Array(indices),
  };
}