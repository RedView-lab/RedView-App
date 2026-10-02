/**
 * RedView Test-Bench : moteur LiDAR WebGPU — précision, LOD, streaming (CPU, sans GPU)
 *
 * Critères durs (code de sortie ≠ 0 en cas d'échec) :
 * 1. Précision des positions décodées (decodeCopcChunks réel, laz-perf simulé)
 *    sur des coordonnées Lambert-93 : < 1 mm (l'ancien stockage absolu Float32
 *    quantifiait le nord à 0,5 m).
 * 2. Taille écran d'un nœud indépendante de l'inclinaison caméra (l'ancienne
 *    focale lue dans viewProj[5] s'effondrait en vue de dessus).
 * 3. Octree LOD additive : chaque point stocké une seule fois, quantification
 *    u16 sous le centimètre.
 * 4. Streaming 9 tuiles : densité complète près de la caméra, budget de points
 *    respecté, mémoire GPU bornée (l'ancien chargement décimait la scène
 *    entière avant l'octree).
 * Optionnel : LIDAR_TILE=<fichier .copc.laz> mesure le pipeline sur une vraie
 * tuile (décodage laz-perf, construction de l'octree LOD, sélection).
 *
 * Usage : npm run bench:lidar-lod   (LIDAR_TILE=... npm run bench:lidar-lod)
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  computeLocalOrigin,
  decodeCopcChunks,
  parseLazBuffer,
  type CopcChunk,
} from '../src/features/lidar/lib/lazParser.ts';
import { createInMemoryLodTile, type OpenedLodTile } from '../src/features/lidar/lib/lodCache.ts';
import { screenSpaceSize } from '../src/features/lidar/viewer/lod/frustum.ts';
import {
  buildLodTile,
  LOD_POINT_STRIDE,
  lodNodeCube,
  unpackLodPosition,
  type LodTileInput,
} from '../src/features/lidar/viewer/lod/lodTile.ts';
import { SceneLod, type SceneNode, type SceneNodeUploader } from '../src/features/lidar/viewer/lod/sceneLod.ts';
import { mat4MultiplyInto } from '../src/features/lidar/viewer/renderer/math.ts';
import type { AABB } from '../src/features/lidar/viewer/lod/types.ts';
import type { PointCloudData } from '../src/features/lidar/types.ts';

interface CheckResult {
  name: string;
  pass: boolean;
  before: string;
  after: string;
}

const results: CheckResult[] = [];
const notes: string[] = [];

function check(name: string, pass: boolean, before: string, after: string): void {
  results.push({ name, pass, before, after });
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Précision : decodeCopcChunks avec un laz-perf simulé
// ---------------------------------------------------------------------------

interface SyntheticRecords {
  X: Int32Array;
  Y: Int32Array;
  Z: Int32Array;
  cls: Uint8Array;
}

/** Minimal stand-in for the laz-perf module: getPoint() writes the next synthetic PDRF 6 record. */
function createMockLazPerf(records: SyntheticRecords) {
  const HEAPU8 = new Uint8Array(1 << 20);
  const view = new DataView(HEAPU8.buffer);
  let heapTop = 64;
  let cursor = 0;
  return {
    HEAPU8,
    _malloc(size: number): number {
      const ptr = heapTop;
      heapTop += (size + 15) & ~15;
      if (heapTop > HEAPU8.length) throw new Error('mock heap exhausted');
      return ptr;
    },
    _free(): void {},
    ChunkDecoder: class {
      open(): void {}
      getPoint(ptr: number): void {
        view.setInt32(ptr, records.X[cursor]!, true);
        view.setInt32(ptr + 4, records.Y[cursor]!, true);
        view.setInt32(ptr + 8, records.Z[cursor]!, true);
        view.setUint16(ptr + 12, 1000, true);
        HEAPU8[ptr + 16] = records.cls[cursor]!;
        cursor++;
      }
      delete(): void {}
    },
  };
}

function runPrecisionCheck(): void {
  const count = 200_000;
  const scale = [0.01, 0.01, 0.01];
  const offset = [0, 0, 0];
  const records: SyntheticRecords = {
    X: new Int32Array(count),
    Y: new Int32Array(count),
    Z: new Int32Array(count),
    cls: new Uint8Array(count),
  };
  // One IGN-like 1 km tile in the Alps (Lambert-93), centimetre resolution, LAS offset 0.
  const rand = createRandom(12345);
  for (let i = 0; i < count; i++) {
    records.X[i] = Math.round((1_000_000 + rand() * 1000) / scale[0]!);
    records.Y[i] = Math.round((6_543_000 + rand() * 1000) / scale[1]!);
    records.Z[i] = Math.round((1200 + rand() * 800) / scale[2]!);
    records.cls[i] = 2;
  }

  const header = { pointDataRecordFormat: 6, pointDataRecordLength: 30, scale, offset };
  const chunks: CopcChunk[] = [{ pointCount: count, bytes: new Uint8Array(8) }];
  const origin = computeLocalOrigin([1_000_000.5, 6_543_000.5, 1200]);

  const t0 = performance.now();
  const decoded = decodeCopcChunks(createMockLazPerf(records), header, chunks, origin);
  const decodeMs = performance.now() - t0;

  let maxErrNew = 0;
  let maxErrLegacy = 0;
  const originArr = [origin.x, origin.y, origin.z];
  for (let i = 0; i < count; i++) {
    const truth = [
      records.X[i]! * scale[0]! + offset[0]!,
      records.Y[i]! * scale[1]! + offset[1]!,
      records.Z[i]! * scale[2]! + offset[2]!,
    ];
    for (let axis = 0; axis < 3; axis++) {
      maxErrNew = Math.max(maxErrNew, Math.abs(decoded.positions[i * 3 + axis]! + originArr[axis]! - truth[axis]!));
      maxErrLegacy = Math.max(maxErrLegacy, Math.abs(Math.fround(truth[axis]!) - truth[axis]!));
    }
  }

  check(
    `Précision positions (200k pts Lambert-93, décodage ${decodeMs.toFixed(0)} ms)`,
    maxErrNew < 0.001,
    `${(maxErrLegacy * 100).toFixed(1)} cm (Float32 absolu)`,
    `${(maxErrNew * 1000).toFixed(3)} mm (origine locale)`,
  );
}

// ---------------------------------------------------------------------------
// 2. Taille écran indépendante de l'inclinaison
// ---------------------------------------------------------------------------

/** Same orbit math as viewer/camera.ts. */
function orbitViewMatrix(radius: number, theta: number, phi: number, target: [number, number, number] = [0, 0, 0]): {
  view: Float32Array;
  eye: [number, number, number];
} {
  const eye: [number, number, number] = [
    target[0] + radius * Math.sin(phi) * Math.sin(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + radius * Math.sin(phi) * Math.cos(theta),
  ];
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fLen = Math.hypot(fx, fy, fz);
  fx /= fLen; fy /= fLen; fz /= fLen;
  let rx = -fz, ry = 0, rz = fx;
  const rLen = Math.hypot(rx, ry, rz) || 1;
  rx /= rLen; ry /= rLen; rz /= rLen;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  const view = new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ]);
  return { view, eye };
}

/** Reversed-Z infinite projection, as camera.getRenderProjMatrix(). */
function renderProjection(aspect: number): Float32Array {
  const f = 1 / Math.tan(Math.PI / 8);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[11] = -1;
  m[14] = 0.05;
  return m;
}

function runScreenSizeCheck(): void {
  const aabb: AABB = { minX: -25, maxX: 25, minY: -25, maxY: 25, minZ: -25, maxZ: 25 };
  const proj = renderProjection(1920 / 1080);
  const viewProj = new Float32Array(16);
  const pitches = [0.05, 0.3, Math.PI / 4, Math.PI / 3, 1.4];
  const fixed: number[] = [];
  const legacy: number[] = [];
  for (const phi of pitches) {
    mat4MultiplyInto(viewProj, proj, orbitViewMatrix(400, 0.7, phi).view);
    fixed.push(screenSpaceSize(aabb, viewProj, 1920, 1080, proj[5]!));
    legacy.push(screenSpaceSize(aabb, viewProj, 1920, 1080, viewProj[5]!));
  }
  const spread = (values: number[]) => Math.max(...values) / Math.max(1e-9, Math.min(...values));
  check(
    'Taille écran nœud selon l’inclinaison (φ 0,05 → 1,4 rad)',
    spread(fixed) < 1.01,
    `écart ×${spread(legacy).toFixed(1)} (vue de dessus : ${legacy[0]!.toFixed(1)} px au lieu de ${fixed[0]!.toFixed(1)})`,
    `écart ×${spread(fixed).toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
// 3–4. Octree LOD et streaming multi-tuiles
// ---------------------------------------------------------------------------

/** Rolling terrain with tree-like clusters, positions relative to a km-aligned origin. */
function syntheticTile(tileX: number, tileY: number, count: number): LodTileInput {
  const rand = createRandom(1000 + tileX * 31 + tileY * 17);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const classifications = new Uint8Array(count);
  const origin = { x: 1_000_000 + tileX * 1000, y: 6_543_000 + tileY * 1000, z: 0 };
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = rand() * 1000;
    const y = rand() * 1000;
    const ground = 1200 + 40 * Math.sin((origin.x + x) / 180) + 30 * Math.cos((origin.y + y) / 140);
    const isTree = rand() < 0.3;
    const z = ground + (isTree ? 2 + rand() * 18 : 0);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    classifications[i] = isTree ? 5 : 2;
    colors[i * 3] = isTree ? 40 : 150;
    colors[i * 3 + 1] = isTree ? 110 : 130;
    colors[i * 3 + 2] = isTree ? 40 : 90;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return {
    positions,
    colors,
    classifications,
    count,
    origin,
    crs: 'LAMB93',
    bounds: {
      minX: origin.x, maxX: origin.x + 1000,
      minY: origin.y, maxY: origin.y + 1000,
      minZ, maxZ,
    },
  };
}

function runLodTileCheck(): void {
  const count = 600_000;
  const input = syntheticTile(0, 0, count);
  const positions = input.positions.slice();
  const t0 = performance.now();
  const tile = buildLodTile(input);
  const buildMs = performance.now() - t0;

  const total = tile.nodes.reduce((sum, node) => sum + node.count, 0);
  let maxErr = 0;
  let sumErr = 0;
  let samples = 0;
  let withinBound = true;
  // Every packed point must decode near an original point; sample by nearest grid bucket.
  const bucket = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.floor(positions[i * 3]!)}:${Math.floor(positions[i * 3 + 1]!)}`;
    let list = bucket.get(key);
    if (!list) bucket.set(key, (list = []));
    list.push(i);
  }
  const view = new DataView(tile.packed.buffer);
  for (const node of tile.nodes) {
    const cube = lodNodeCube(tile.header, node);
    // Rounding to the u16 grid of the node cube: at most half a step per axis.
    const bound = (cube.size / 65535) * (Math.sqrt(3) / 2) + 1e-4;
    for (let k = 0; k < node.count; k += 97) {
      const [x, y, z] = unpackLodPosition(view, node.byteOffset + k * LOD_POINT_STRIDE, cube);
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const i of bucket.get(`${Math.floor(x) + dx}:${Math.floor(y) + dy}`) ?? []) {
            best = Math.min(best, Math.hypot(positions[i * 3]! - x, positions[i * 3 + 1]! - y, positions[i * 3 + 2]! - z));
          }
        }
      }
      maxErr = Math.max(maxErr, best);
      sumErr += best;
      samples++;
      if (best > bound) withinBound = false;
    }
  }
  check(
    `Octree LOD additive (600k pts, ${tile.nodes.length} nœuds, ${buildMs.toFixed(0)} ms)`,
    total === count && tile.packed.byteLength === count * LOD_POINT_STRIDE && withinBound,
    'octree reconstruite + échantillons voxels dupliqués (16 o/pt + doublons)',
    `${total === count ? 'chaque point une fois' : `${total} ≠ ${count}`}, 12 o/pt, ` +
    `erreur moyenne ${((sumErr / Math.max(1, samples)) * 1000).toFixed(2)} mm (max ${(maxErr * 1000).toFixed(1)} mm, racine d’1 km)`,
  );
}

class CountingUploader implements SceneNodeUploader {
  resident = new Set<number>();
  peakPoints = 0;
  private points = 0;
  uploadNode(node: SceneNode): boolean {
    this.resident.add(node.id);
    this.points += node.entry.count;
    this.peakPoints = Math.max(this.peakPoints, this.points);
    return true;
  }
  releaseNode(node: SceneNode): void {
    if (this.resident.delete(node.id)) this.points -= node.entry.count;
  }
}

async function settle(scene: SceneLod, frame: () => void): Promise<number> {
  let frames = 0;
  for (; frames < 400; frames++) {
    frame();
    if (scene.isIdle()) {
      frame();
      if (scene.isIdle()) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}

/** Share of the points near (x, z) that the selection draws. */
function densityNear(scene: SceneLod, x: number, z: number, radius: number): number {
  const selected = new Set(scene.getSelectedNodes().map((node) => node.id));
  let drawn = 0;
  let total = 0;
  for (const node of scene.nodes) {
    if (node.entry.count === 0) continue;
    const dx = Math.max(node.minX - x, 0, x - node.maxX);
    const dz = Math.max(node.minZ - z, 0, z - node.maxZ);
    if (Math.hypot(dx, dz) > radius) continue;
    // Only nodes small enough to be "local" measure density, big ones span the area.
    if (node.size > radius * 4) continue;
    total += node.entry.count;
    if (selected.has(node.id)) drawn += node.entry.count;
  }
  return total > 0 ? drawn / total : 1;
}

/** Historical multi-tile cap (resolveMultiTilePointCap, 8 GB, discrete GPU), kept to report the "before". */
function legacyMultiTileCap(tileCount: number): number {
  let cap = 8_000_000;
  const boost = tileCount >= 8 ? 0.25 : tileCount >= 6 ? 0.5 : tileCount >= 4 ? 0.75 : 1;
  cap += 2_000_000 * boost;
  if (tileCount >= 8) cap *= 0.7;
  else if (tileCount >= 6) cap *= 0.8;
  else if (tileCount >= 4) cap *= 0.9;
  return Math.min(12_000_000, Math.max(2_500_000, Math.round(cap / 250_000) * 250_000));
}

async function runStreamingCheck(): Promise<void> {
  const perTile = 400_000;
  const tiles: OpenedLodTile[] = [];
  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) {
      tiles.push(createInMemoryLodTile(buildLodTile(syntheticTile(tx, ty, perTile))));
    }
  }
  const totalPoints = perTile * tiles.length;
  const center = { x: 1_000_500, y: 6_543_500, z: 1200 };
  const uploader = new CountingUploader();
  const pointBudget = 1_200_000;
  const poolBudget = 1_600_000;
  const scene = new SceneLod(tiles, center, {
    pointBudget,
    poolBudget,
    maxResidentNodes: 16384,
    uploader,
    onNodeResident: () => undefined,
  });
  const proj = renderProjection(1920 / 1080);
  const viewProj = new Float32Array(16);
  const frameAt = (target: [number, number, number], radius: number, phi: number) => () => {
    const { view, eye } = orbitViewMatrix(radius, 0.4, phi, target);
    mat4MultiplyInto(viewProj, proj, view);
    scene.update(viewProj, proj[5]!, eye[0], eye[1], eye[2], 1080);
  };

  // Close-up over the centre tile, then a wide view, then back.
  const near = frameAt([0, 0, 0], 60, 0.9);
  const t0 = performance.now();
  const framesNear = await settle(scene, near);
  const nearMs = performance.now() - t0;
  const stats = scene.getStats();
  const density = densityNear(scene, 0, 0, 25);
  const wide = frameAt([0, 0, 0], 2500, 0.7);
  await settle(scene, wide);
  const wideStats = scene.getStats();
  await settle(scene, near);
  const backDensity = densityNear(scene, 0, 0, 25);

  const legacyFraction = legacyMultiTileCap(9) / (20_000_000 * 9);
  check(
    `Streaming 9 tuiles : densité près de la caméra (${framesNear} frames, ${nearMs.toFixed(0)} ms)`,
    density >= 0.999 && backDensity >= 0.999,
    `${(legacyFraction * 100).toFixed(1)} % des points (plafond ${(legacyMultiTileCap(9) / 1e6).toFixed(1)} M pour 9 × 20 M)`,
    `${(density * 100).toFixed(1)} % (et ${(backDensity * 100).toFixed(1)} % après un aller-retour vue large)`,
  );
  check(
    'Streaming 9 tuiles : budget de points et mémoire GPU bornés',
    stats.selectedPoints <= pointBudget && wideStats.selectedPoints <= pointBudget && uploader.peakPoints <= poolBudget,
    'scène entière en mémoire GPU (16 o/pt), cap global avant octree',
    `sélection ${(stats.selectedPoints / 1e6).toFixed(2)} M / vue large ${(wideStats.selectedPoints / 1e6).toFixed(2)} M ≤ ${(pointBudget / 1e6).toFixed(1)} M · pic GPU ${(uploader.peakPoints / 1e6).toFixed(2)} M ≤ ${(poolBudget / 1e6).toFixed(1)} M pts sur ${(totalPoints / 1e6).toFixed(1)} M`,
  );
}

// ---------------------------------------------------------------------------
// Optionnel : vraie tuile (LIDAR_TILE)
// ---------------------------------------------------------------------------

async function runRealTile(path: string): Promise<void> {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  const wasmModule = await WebAssembly.compile(readFileSync(resolvePath('public/laz-perf.wasm')));
  const t0 = performance.now();
  const pc: PointCloudData = await parseLazBuffer(buffer, undefined, undefined, wasmModule);
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
    `  décodage ${(decodeMs / 1000).toFixed(1)} s (1 thread) · octree LOD ${(buildMs / 1000).toFixed(2)} s · ` +
    `${tile.nodes.length} nœuds (${[...depthCounts.entries()].map(([d, n]) => `p${d}:${n}`).join(' ')}) · ` +
    `${(tile.packed.byteLength / 1e6).toFixed(0)} Mo (12 o/pt) contre ${((pc.count * 16) / 1e6).toFixed(0)} Mo + voxels avant`,
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
      `GPU résident ${(s.residentPoints / 1e6).toFixed(2)} M · convergé en ${elapsed.toFixed(0)} ms`,
    );
  }
}

// ---------------------------------------------------------------------------

runPrecisionCheck();
runScreenSizeCheck();
runLodTileCheck();
await runStreamingCheck();
if (process.env.LIDAR_TILE) await runRealTile(process.env.LIDAR_TILE);

console.log('\nLiDAR WebGPU — précision / LOD / streaming\n');
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}`);
  console.log(`      avant : ${result.before}`);
  console.log(`      après : ${result.after}`);
}
if (notes.length) console.log(`\n${notes.join('\n')}`);
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} critères respectés`);
if (failed.length > 0) process.exit(1);
