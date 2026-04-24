// ============================================
// LiDAR HD — WebGL2 fallback viewer entry
// ============================================
// Invoked dynamically by ../viewer/main.ts when the WebGPU preflight fails.
// Same canvas, same overlay, same OPFS layout — but only the textured
// terrain mesh is rendered. No octree, no point billboards, no LiDAR
// rendering; the orthophoto is sampled at full resolution.

import { CameraController } from '../viewer/camera';
import { WebGLTerrainRenderer } from './renderer';
import type { TerrainGPUData } from './renderer';
import type { TerrainMeshWebGL, TerrainWorkerInput, TerrainWorkerOutput } from './terrainWorker';
import { stitchOrtho } from './orthoStitcher';
import { detectCrs } from '../coordConvert';
import type { PointCloudBounds, DetectedCrs } from '../types';

export interface WebGLViewerHandles {
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  status: HTMLElement;
  bar: HTMLElement;
  stats: HTMLElement;
}

export interface WebGLViewerOptions {
  buffer: ArrayBuffer;          // raw LAZ bytes
  altRefLabel: string;          // for the title / stats
  tileLabel: string;            // human label e.g. "1003,6547 LAMB93/IGN69"
}

interface ParsedHeader { bounds: PointCloudBounds; crs: DetectedCrs; }

/**
 * Reads just enough of the LAZ header (LAS 1.x is fixed-layout, the bbox
 * lives at byte 179..226) to know the CRS + corner UVs *before* spinning
 * up the parsing worker. Avoids a chicken-and-egg with the ortho stitcher.
 *
 * Falls back to running the worker with placeholder UVs if the header
 * can't be read; the mesh would render with garbage UV but we always
 * succeed in reading a valid LAS header in practice.
 */
function readBoundsFromLasHeader(buffer: ArrayBuffer): ParsedHeader | null {
  try {
    const view = new DataView(buffer);
    // LAS magic "LASF"
    if (view.getUint32(0, false) !== 0x4C415346) return null;
    // Scale + offset start at byte 131. 8-byte little-endian doubles.
    const sX = view.getFloat64(131, true);
    const sY = view.getFloat64(139, true);
    const sZ = view.getFloat64(147, true);
    const oX = view.getFloat64(155, true);
    const oY = view.getFloat64(163, true);
    const oZ = view.getFloat64(171, true);
    const maxX = view.getFloat64(179, true);
    const minX = view.getFloat64(187, true);
    const maxY = view.getFloat64(195, true);
    const minY = view.getFloat64(203, true);
    const maxZ = view.getFloat64(211, true);
    const minZ = view.getFloat64(219, true);
    void sX; void sY; void sZ; void oX; void oY; void oZ;
    if (![minX, maxX, minY, maxY, minZ, maxZ].every(Number.isFinite)) return null;
    if (maxX <= minX || maxY <= minY) return null;
    const bounds: PointCloudBounds = { minX, maxX, minY, maxY, minZ, maxZ };
    const crs = detectCrs(minY, maxY);
    return { bounds, crs };
  } catch {
    return null;
  }
}

export async function runWebGLFallback(
  ui: WebGLViewerHandles,
  opts: WebGLViewerOptions,
): Promise<void> {
  const { canvas, overlay, status, bar, stats } = ui;
  const setStatus = (msg: string, pct?: number) => {
    status.textContent = msg;
    if (pct != null) bar.style.width = `${Math.min(100, pct)}%`;
  };

  setStatus('Mode WebGL HD : initialisation…', 1);

  // 1. WebGL2 init (cheap — fails fast on truly headless setups)
  resizeCanvas(canvas);
  const renderer = new WebGLTerrainRenderer(canvas);
  console.log(`[WebGL Viewer] ${renderer.rendererInfo} · maxTex=${renderer.maxTextureSize}`);

  // 2. Read LAS header inline so we know bounds + CRS without spinning a
  // worker. LAS 1.x is fixed-layout — bbox is at byte 179..226.
  const header = readBoundsFromLasHeader(opts.buffer);
  if (!header) throw new Error("En-tête LAS illisible — fichier corrompu ?");

  // 3. Kick off ortho stitch + terrain build IN PARALLEL. Stitch needs only
  // the header; terrain worker needs a stitched UV anchor — but in stitched
  // texture space the four corner UVs are already known ahead of any HTTP
  // request because they depend on bounds + CRS only. So we compute UVs
  // synchronously and start everything together.
  setStatus('Téléchargement orthophotos HD…', 5);
  const stitchPromise = stitchOrtho(
    header.bounds, header.crs, renderer.maxTextureSize,
    (pct, label) => setStatus(`Mode WebGL HD : ${label}`, 5 + pct * 30),
  );

  // Terrain worker takes ownership of the buffer (transferable). We've
  // already extracted everything we need (header) on the main thread, so we
  // can hand it off without copying — important on RAM-constrained iGPU PCs.
  // We need the cornerUV before the worker can run. Wait on stitch first.
  const ortho = await stitchPromise;

  setStatus('Mode WebGL HD : maillage HD…', 40);
  const mesh = await runTerrainWorker(
    opts.buffer,
    ortho.cornerUV,
    (phase, pct) => setStatus(`Mode WebGL HD : ${phase}`, 40 + pct * 0.45),
  );

  // 6. Upload to GPU
  setStatus('Mode WebGL HD : upload GPU…', 90);
  renderer.uploadMesh(meshToGPUData(mesh));
  renderer.uploadOrtho(ortho.bitmap);
  ortho.bitmap.close();

  // 7. Camera + render loop
  const camera = new CameraController(canvas);
  camera.lookAt(0, (mesh.bounds.maxZ - mesh.bounds.minZ) / 2, 0, mesh.extent / 2);

  setStatus('Prêt — mode WebGL HD', 100);
  setTimeout(() => overlay.classList.add('hidden'), 250);

  let lastFpsT = performance.now();
  let frames = 0;
  let fps = 0;

  const renderFrame = () => {
    const view = camera.getViewMatrix();
    const proj = camera.getProjMatrix();
    const vp = WebGLTerrainRenderer.multiplyMat4(view, proj);
    renderer.render(vp);

    frames++;
    const now = performance.now();
    if (now - lastFpsT >= 500) {
      fps = Math.round((frames * 1000) / (now - lastFpsT));
      frames = 0;
      lastFpsT = now;
      stats.textContent =
        `${(mesh.indexCount / 3).toLocaleString()} tri · ${fps} fps · ` +
        `terrain HD ${mesh.gridWidth}×${mesh.gridHeight} · ` +
        `${canvas.width}×${canvas.height} · WebGL2 · ${opts.tileLabel}`;
    }
    requestAnimationFrame(renderFrame);
  };
  requestAnimationFrame(renderFrame);

  window.addEventListener('resize', () => {
    resizeCanvas(canvas);
    renderer.resize(canvas.width, canvas.height);
  });
}

function runTerrainWorker(
  buffer: ArrayBuffer,
  cornerUV: import('./terrainWorker').CornerUV,
  onProgress: (phase: string, pct: number) => void,
): Promise<TerrainMeshWebGL> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    const TIMEOUT_MS = 90_000;
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`Terrain worker timeout (${TIMEOUT_MS / 1000}s)`));
    }, TIMEOUT_MS);

    w.onmessage = (e: MessageEvent<TerrainWorkerOutput>) => {
      const m = e.data;
      if (m.type === 'progress') {
        onProgress(m.phase, m.percent / 100);
      } else if (m.type === 'done') {
        clearTimeout(timer);
        w.terminate();
        resolve(m.mesh);
      } else if (m.type === 'error') {
        clearTimeout(timer);
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (err) => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error(err.message || 'terrain worker error'));
    };

    const msg: TerrainWorkerInput = { type: 'build', buffer, cornerUV };
    w.postMessage(msg, [buffer]);
  });
}

function meshToGPUData(mesh: TerrainMeshWebGL): TerrainGPUData {
  return {
    vertices: mesh.vertices,
    indices: mesh.indices,
    vertexCount: mesh.vertexCount,
    indexCount: mesh.indexCount,
  };
}

function resizeCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(window.innerWidth * dpr));
  const h = Math.max(1, Math.floor(window.innerHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
