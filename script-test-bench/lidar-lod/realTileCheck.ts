import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseLazBuffer } from '../../src/features/lidar/lib/lazParser.ts';
import { createInMemoryLodTile } from '../../src/features/lidar/lib/lodCache.ts';
import {
  buildLodTile,
  LOD_POINT_STRIDE,
  lodNodeCube,
  lodNodeSpacing,
  unpackLodPosition,
} from '../../src/features/lidar/viewer/lod/lodTile.ts';
import { CONTENT_MARGIN_CELLS, SceneLod } from '../../src/features/lidar/viewer/lod/sceneLod.ts';
import { mat4MultiplyInto } from '../../src/features/lidar/viewer/renderer/math.ts';
import type { PointCloudData } from '../../src/features/lidar/types.ts';
import { check, notes } from './harness.ts';
import { orbitViewMatrix, renderProjection } from './screenSizeCheck.ts';
import { CountingUploader, settle } from './streamingCheck.ts';

// ---------------------------------------------------------------------------
// Optionnel : vraie tuile (LIDAR_TILE)
// ---------------------------------------------------------------------------

export async function runRealTile(path: string): Promise<void> {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  const wasmModule = await WebAssembly.compile(readFileSync(resolvePath('public/laz-perf.wasm')));
  // The viewer's decoder (laz-perf stays its fallback).
  const redviewLazModule = await WebAssembly.compile(readFileSync(resolvePath('src/features/lidar/lib/laz/pkg/redviewlaz_bg.wasm')));
  const t0 = performance.now();
  const pc: PointCloudData = await parseLazBuffer(buffer, undefined, undefined, wasmModule, redviewLazModule);
  const decodeMs = performance.now() - t0;
  // Neutral colour: orthophoto colourisation needs the network and is not under test.
  pc.colors.fill(128);
  const t1 = performance.now();
  const tile = buildLodTile({ ...pc, embeddedRgb: false });
  const buildMs = performance.now() - t1;
  const depthCounts = new Map<number, number>();
  for (const node of tile.nodes) depthCounts.set(node.depth, (depthCounts.get(node.depth) ?? 0) + 1);
  notes.push(
    `Tuile réelle ${path.split(/[\\/]/).pop()} : ${pc.count.toLocaleString('fr-FR')} pts, ` +
    `${pc.copc ? 'COPC' : 'LAS/LAZ'}, origine ${pc.origin.x}/${pc.origin.y}`,
    `  décodage ${(decodeMs / 1000).toFixed(1)} s (1 thread, décodeur RedView LAZ) · octree LOD ${(buildMs / 1000).toFixed(2)} s · ` +
    `${tile.nodes.length} nœuds (${[...depthCounts.entries()].map(([d, n]) => `p${d}:${n}`).join(' ')}) · ` +
    `${(tile.packed.byteLength / 1e6).toFixed(0)} Mo (${LOD_POINT_STRIDE} o/pt, couleurs filtrées incluses)`,
  );

  // The LOD shrinks a node's bounds to its own points plus CONTENT_MARGIN_CELLS
  // cells: every point of its subtree must fall within that margin.
  const view = new DataView(tile.packed.buffer, tile.packed.byteOffset, tile.packed.byteLength);
  const own = tile.nodes.map((node) => {
    const cube = lodNodeCube(tile.header, node);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < node.count; k++) {
      const p = unpackLodPosition(view, node.byteOffset + k * LOD_POINT_STRIDE, cube);
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis]!, p[axis]!);
        box[axis + 3] = Math.max(box[axis + 3]!, p[axis]!);
      }
    }
    return box;
  });
  let worstCells = 0;
  tile.nodes.forEach((node, i) => {
    const box = own[i]!;
    if (!Number.isFinite(box[0]!)) return;
    let excess = 0;
    tile.nodes.forEach((other, j) => {
      const shift = other.depth - node.depth;
      if (shift <= 0 || (other.x >> shift) !== node.x || (other.y >> shift) !== node.y || (other.z >> shift) !== node.z) return;
      const sub = own[j]!;
      if (!Number.isFinite(sub[0]!)) return;
      for (let axis = 0; axis < 3; axis++) excess = Math.max(excess, box[axis]! - sub[axis]!, sub[axis + 3]! - box[axis + 3]!);
    });
    worstCells = Math.max(worstCells, excess / lodNodeSpacing(tile.header, node.depth));
  });
  check(
    'Tuile réelle : marge des bornes serrées',
    worstCells < CONTENT_MARGIN_CELLS,
    'bornes = cube de l’octree',
    `sous-arbres à ${worstCells.toFixed(2)} maille(s) au plus des points de leur nœud < marge ${CONTENT_MARGIN_CELLS}`,
  );

  const opened = createInMemoryLodTile(tile);
  const centerX = (pc.bounds.minX + pc.bounds.maxX) / 2;
  const centerY = (pc.bounds.minY + pc.bounds.maxY) / 2;
  const centerZ = (pc.bounds.minZ + pc.bounds.maxZ) / 2;
  const uploader = new CountingUploader();
  const scene = new SceneLod([opened], { x: centerX, y: centerY, z: centerZ }, {
    pointBudget: 6_000_000,
    poolBudget: 8_000_000,
    maxResidentNodes: 16384,
    uploader,
    onNodeResident: () => undefined,
  });
  const proj = renderProjection(1920 / 1080);
  const viewProj = new Float32Array(16);
  for (const [label, radius, phi] of [['vue d’ensemble', 1300, 0.8], ['vue de dessus', 900, 0.05], ['gros plan 80 m', 80, 1.0]] as const) {
    const frame = () => {
      const { view, eye } = orbitViewMatrix(radius, 0.6, phi);
      mat4MultiplyInto(viewProj, proj, view);
      scene.update(viewProj, proj[5]!, eye[0], eye[1], eye[2], 1080);
    };
    const t = performance.now();
    await settle(scene, frame);
    const elapsed = performance.now() - t;
    const s = scene.getStats();
    notes.push(
      `  ${label} : ${(s.selectedPoints / 1e6).toFixed(2)} M pts en ${s.selectedNodes} nœuds · ` +
      `GPU résident ${(s.residentPoints / 1e6).toFixed(2)} M · ${uploader.uploads} blocs lus depuis le début · convergé en ${elapsed.toFixed(0)} ms`,
    );
  }
}
