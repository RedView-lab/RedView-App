// ============================================
// Standalone LiDAR HD Viewer — Entry Point
// ============================================
// Reads tile params from URL, loads from OPFS, parses+colorizes in a Worker, renders with WebGPU.

import { LidarRenderer } from './renderer';
import type { HeightmapParams } from './renderer';
import { CameraController } from './camera';
import { buildTileFileName } from '../coordConvert';
import { saveColorizedData, loadColorizedData, saveTerrainData, loadTerrainData } from '../storage';
import type { DetectedCrs, AltitudeRef, PointCloudData } from '../types';
import type { WorkerResponse } from '../processWorker';
import type { FlatOctree, AABB, OctreeWorkerResponse } from './lod/types';
import { LodManager } from './lod/lodManager';

// --- DOM refs ---
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const overlay = document.getElementById('overlay')!;
const statusEl = document.getElementById('status')!;
const barFill = document.getElementById('bar-fill')!;
const statsEl = document.getElementById('stats')!;

function setStatus(msg: string, pct?: number) {
  statusEl.textContent = msg;
  if (pct != null) barFill.style.width = `${Math.min(100, pct)}%`;
}

// --- Parse URL params ---
const params = new URLSearchParams(window.location.search);
const xKm = parseInt(params.get('x') || '', 10);
const yKm = parseInt(params.get('y') || '', 10);
const crs = (params.get('crs') || 'LAMB93') as DetectedCrs;
const altRef = (params.get('alt') || 'IGN69') as AltitudeRef;

if (isNaN(xKm) || isNaN(yKm)) {
  setStatus('❌ Paramètres invalides. URL: ?x=1003&y=6547&crs=LAMB93&alt=IGN69');
  throw new Error('Invalid viewer params');
}

const tileFileName = `${buildTileFileName(xKm, yKm, crs, altRef)}.copc.laz`;
// Legacy naming used yKm directly instead of yKm+1 (NW corner). Fall back to it
// for tiles downloaded before the naming convention fix.
const legacyTileFileName = `${buildTileFileName(xKm, yKm - 1, crs, altRef)}.copc.laz`;
document.title = `LiDAR — ${tileFileName}`;

// --- Load tile from OPFS ---
async function loadFromOPFS(): Promise<ArrayBuffer> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('lidar-hd');
  for (const name of [tileFileName, legacyTileFileName]) {
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return file.arrayBuffer();
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Tile not found in OPFS: ${tileFileName}`);
}

/** Run parse+colorize in a Web Worker */
function processInWorker(buffer: ArrayBuffer): Promise<PointCloudData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../processWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const base = msg.phase === 'parsing' ? 15 : 50;
        const scale = msg.phase === 'parsing' ? 0.35 : 0.3;
        setStatus(`${msg.phase === 'parsing' ? 'Parsing' : 'Colorisation'} : ${msg.message}`, base + msg.percent * scale);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          positions: msg.positions,
          colors: msg.colors,
          classifications: msg.classifications,
          count: msg.count,
          bounds: msg.bounds,
          crs: msg.crs as DetectedCrs,
        });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };

    worker.postMessage({ type: 'process', buffer }, [buffer]);
  });
}

// --- Main ---
let renderer: LidarRenderer | null = null;

(async () => {
  try {
    // 1. Try loading colorized cache first
    setStatus('Chargement du cache colorisé...', 5);
    let pointCloud = await loadColorizedData(tileFileName);

    if (pointCloud) {
      console.log('[Viewer] Loaded colorized cache — skipping parse+colorize');
      setStatus('Cache colorisé chargé', 80);
    } else {
      // 2. No cache — load raw LAZ, parse + colorize in Worker
      setStatus(`Chargement LAZ : ${tileFileName}`, 10);
      const buffer = await loadFromOPFS();
      setStatus(`Fichier chargé (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`, 15);

      pointCloud = await processInWorker(buffer);
      setStatus('Traitement terminé — mise en cache...', 78);

      await saveColorizedData(tileFileName, pointCloud);
      setStatus('Cache colorisé sauvegardé', 80);
    }

    // 3. Build RGBA colors
    const rgba = buildRGBA(pointCloud);

    // 3b. Generate terrain heightmap mesh (cached)
    setStatus('Génération du terrain...', 82);
    let terrainMesh = await loadTerrainData(tileFileName);
    if (terrainMesh) {
      console.log('[Viewer] Loaded terrain cache');
    } else {
      const { generateHeightmap } = await import('./heightmap');
      terrainMesh = await generateHeightmap(pointCloud);
      await saveTerrainData(tileFileName, terrainMesh);
    }
    console.log(`[Viewer] Terrain: ${terrainMesh.vertexCount.toLocaleString()} vertices, ${(terrainMesh.indexCount / 3).toLocaleString()} triangles`);

    // 4. Center positions relative to bounding box center
    const { positions } = centerPositions(pointCloud);

    // 5. Init WebGPU
    setStatus('Initialisation WebGPU...', 85);
    resizeCanvas();
    renderer = new LidarRenderer();
    await renderer.init(canvas);
    // Re-resize with platform-aware DPR cap now that we know the GPU
    resizeCanvas();
    renderer.resize(canvas.width, canvas.height);

    // 5b. Upload heightmap texture for GPU Sobel normals
    const cx = (pointCloud.bounds.minX + pointCloud.bounds.maxX) / 2;
    const cy = (pointCloud.bounds.minY + pointCloud.bounds.maxY) / 2;
    const rangeX = pointCloud.bounds.maxX - pointCloud.bounds.minX;
    const rangeY = pointCloud.bounds.maxY - pointCloud.bounds.minY;
    renderer.setHeightmap({
      data: terrainMesh.heightGrid,
      width: terrainMesh.gridWidth,
      height: terrainMesh.gridHeight,
      originX: pointCloud.bounds.minX - cx,
      originZ: -(pointCloud.bounds.maxY - cy),
      scaleX: rangeX,
      scaleZ: rangeY,
    } as HeightmapParams);

    const extent = Math.max(
      pointCloud.bounds.maxX - pointCloud.bounds.minX,
      pointCloud.bounds.maxY - pointCloud.bounds.minY,
      pointCloud.bounds.maxZ - pointCloud.bounds.minZ,
    );
    renderer.pointSize = 0.59;
    renderer.lodThreshold = Math.max(50, extent * 0.5);

    // 6. Build octree LOD in Web Worker
    setStatus('Construction octree LOD...', 87);
    const centeredBounds: AABB = {
      minX: pointCloud.bounds.minX - cx,
      maxX: pointCloud.bounds.maxX - cx,
      minY: (pointCloud.bounds.minZ - (pointCloud.bounds.minZ + pointCloud.bounds.maxZ) / 2),
      maxY: (pointCloud.bounds.maxZ - (pointCloud.bounds.minZ + pointCloud.bounds.maxZ) / 2),
      minZ: -(pointCloud.bounds.maxY - cy),
      maxZ: -(pointCloud.bounds.minY - cy),
    };

    const octree = await buildOctreeInWorker(positions, rgba, centeredBounds);
    console.log(`[Viewer] Octree: ${octree.nodeCount} nodes, depth ${octree.maxDepthReached}, ${octree.totalVoxelSamples.toLocaleString()} voxels`);

    // 6b. Upload octree data to GPU
    setStatus('Upload GPU (octree)...', 92);
    renderer.setOctreeData(octree);
    renderer.setMesh(terrainMesh.vertices, terrainMesh.colors, terrainMesh.indices);

    // 7. Camera + LOD Manager
    const camera = new CameraController(canvas);
    const halfExt = extent / 2;
    camera.lookAt(0, (pointCloud.bounds.maxZ - pointCloud.bounds.minZ) / 2, 0, halfExt);

    const lodManager = new LodManager();
    lodManager.setOctree(octree);
    if (renderer.platform) lodManager.applyPlatformProfile(renderer.platform);

    // Done — hide overlay
    setStatus('Prêt', 100);
    setTimeout(() => overlay.classList.add('hidden'), 300);

    // 8. Render loop with LOD
    let showLodStats = true;
    let lastFrameTime = performance.now();

    const renderLoop = () => {
      if (!renderer) return;
      const now = performance.now();
      const deltaMs = now - lastFrameTime;
      lastFrameTime = now;

      renderer.updateCamera(camera.getViewMatrix(), camera.getProjMatrix());

      const [cpx, cpy, cpz] = renderer.lastCamPos;
      const [cfx, cfy, cfz] = renderer.lastCamFwd;
      lodManager.update(
        renderer.lastViewProj,
        cpx, cpy, cpz,
        cfx, cfy, cfz,
        canvas.width, canvas.height,
        deltaMs,
      );

      const voxelSize = lodManager.getVoxelPointSize(renderer.pointSize);
      renderer.renderLOD(lodManager.getVisibleNodes(), voxelSize);

      const s = lodManager.stats;
      const gpu = renderer.platform?.isApple ? ' [Apple]' : '';
      if (showLodStats) {
        statsEl.textContent =
          `${s.visiblePoints.toLocaleString()} / ${s.totalPoints.toLocaleString()} pts` +
          ` · ${s.fps} fps · budget ${(s.pointBudget / 1000).toFixed(0)}K` +
          ` · ${s.visibleNodes} nodes · cull ${s.frustumCulled} · lod ${s.lodSkipped}` +
          ` · voxel ${renderer.pointSize.toFixed(2)}m` +
          ` · ${canvas.width}×${canvas.height}${gpu}`;
      } else {
        statsEl.textContent = `${pointCloud.count.toLocaleString()} pts · voxel ${renderer.pointSize.toFixed(2)}m · ${tileFileName}`;
      }
      requestAnimationFrame(renderLoop);
    };
    requestAnimationFrame(renderLoop);

    // Handle resize
    window.addEventListener('resize', () => {
      if (!renderer) return;
      resizeCanvas();
      renderer.resize(canvas.width, canvas.height);
    });

    // Keyboard controls
    window.addEventListener('keydown', (e) => {
      if (!renderer) return;
      if (e.key === '+' || e.key === '=') renderer.pointSize *= 1.2;
      if (e.key === '-' || e.key === '_') renderer.pointSize /= 1.2;
      renderer.pointSize = Math.max(0.01, Math.min(10, renderer.pointSize));
      if (e.key === 't' || e.key === 'T') renderer.terrainVisible = !renderer.terrainVisible;
      if (e.key === 'l' || e.key === 'L') {
        renderer.lodThreshold = renderer.lodThreshold > 0 ? 0 : Math.max(50, extent * 0.5);
      }
      if (e.key === 'q' || e.key === 'Q') showLodStats = !showLodStats;
    });

  } catch (err: any) {
    setStatus(`❌ Erreur : ${err.message}`);
    console.error(err);
  }
})();

// --- Helpers ---

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  // Cap resolution to avoid oversized canvases on high-DPR screens (Retina Mac M1 etc.)
  const MAX_DIM = renderer?.platform?.maxCanvasDim ?? 4096;
  const maxDim = Math.max(window.innerWidth, window.innerHeight);
  const effectiveDpr = Math.min(dpr, MAX_DIM / maxDim);
  canvas.width = Math.floor(window.innerWidth * effectiveDpr);
  canvas.height = Math.floor(window.innerHeight * effectiveDpr);
}

function buildRGBA(pc: PointCloudData): Uint8Array {
  const rgba = new Uint8Array(pc.count * 4);
  for (let i = 0; i < pc.count; i++) {
    rgba[i * 4 + 0] = pc.colors[i * 3 + 0];
    rgba[i * 4 + 1] = pc.colors[i * 3 + 1];
    rgba[i * 4 + 2] = pc.colors[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

function centerPositions(pc: PointCloudData): { positions: Float32Array; origin: [number, number, number] } {
  const cx = (pc.bounds.minX + pc.bounds.maxX) / 2;
  const cy = (pc.bounds.minY + pc.bounds.maxY) / 2;
  const cz = (pc.bounds.minZ + pc.bounds.maxZ) / 2;

  const out = new Float32Array(pc.count * 3);
  for (let i = 0; i < pc.count; i++) {
    const j = i * 3;
    out[j + 0] = pc.positions[j + 0] - cx;      // X → X
    out[j + 1] = pc.positions[j + 2] - cz;      // Z (up) → Y (up)
    out[j + 2] = -(pc.positions[j + 1] - cy);   // -Y (north) → Z (into screen)
  }

  return { positions: out, origin: [cx, cy, cz] };
}

function buildOctreeInWorker(positions: Float32Array, colors: Uint8Array, bounds: AABB): Promise<FlatOctree> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lod/octreeWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<OctreeWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setStatus(`Octree: ${msg.message}`, 87 + msg.percent * 0.05);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          root: msg.root,
          leafPositions: msg.leafPositions,
          leafColors: msg.leafColors,
          voxelPositions: msg.voxelPositions,
          voxelColors: msg.voxelColors,
          totalLeafPoints: msg.totalLeafPoints,
          totalVoxelSamples: msg.totalVoxelSamples,
          maxDepthReached: msg.maxDepthReached,
          nodeCount: msg.nodeCount,
        });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };

    worker.postMessage(
      { type: 'build', positions, colors, bounds },
      [positions.buffer, colors.buffer],
    );
  });
}
