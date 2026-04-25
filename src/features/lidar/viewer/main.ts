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

// --- WebGPU preflight ---
// Runs BEFORE any heavy work (OPFS, WASM laz-perf, Worker). On machines
// without a real GPU (Windows iGPU / driverless / fallback adapter), the
// viewer is unusable — bail with a clear French error UI instead of
// letting laz-perf throw an opaque WASM "Exception catching is disabled".
type PreflightResult =
  | { ok: true; vendor: string; arch: string; desc: string }
  | { ok: false; code: 'no-webgpu' | 'no-adapter' | 'fallback-adapter' | 'software-adapter'; detail: string };

async function preflightWebGPU(): Promise<PreflightResult> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return { ok: false, code: 'no-webgpu', detail: 'navigator.gpu indisponible' };
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e: any) {
    return { ok: false, code: 'no-adapter', detail: e?.message || 'requestAdapter a échoué' };
  }
  if (!adapter) {
    return { ok: false, code: 'no-adapter', detail: 'Aucun GPUAdapter retourné' };
  }
  // Chromium exposes isFallbackAdapter when the only available backend is a
  // software rasterizer (SwiftShader / WARP).
  if ((adapter as any).isFallbackAdapter === true) {
    return { ok: false, code: 'fallback-adapter', detail: 'Adapter logiciel (fallback) détecté' };
  }
  const info = (adapter as any).info ?? {};
  const vendor = String(info.vendor ?? '').toLowerCase();
  const arch = String(info.architecture ?? '').toLowerCase();
  const desc = String(info.description ?? info.device ?? '').toLowerCase();
  // Heuristic detection of software / Windows non-GPU configurations.
  const softwareSignatures = [
    'swiftshader',     // Chrome software backend
    'llvmpipe',        // Mesa software
    'lavapipe',        // Mesa Vulkan software
    'microsoft basic', // Microsoft Basic Render Driver
    'basic render',
    'warp',            // Windows Advanced Rasterization Platform
  ];
  const haystack = `${vendor} ${arch} ${desc}`;
  if (softwareSignatures.some((s) => haystack.includes(s))) {
    return { ok: false, code: 'software-adapter', detail: `Adapter logiciel: ${desc || vendor || 'inconnu'}` };
  }
  return { ok: true, vendor, arch, desc };
}

function showFatalError(opts: { title: string; message: string; hint?: string; technical?: string }) {
  // Replace the loading UI with a styled error card.
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div style="
      max-width: 560px;
      padding: 28px 32px;
      background: rgba(20, 24, 40, 0.85);
      border: 1px solid rgba(255, 80, 80, 0.35);
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      color: #fff;
      font-family: system-ui, sans-serif;
      text-align: center;
    ">
      <div style="font-size: 40px; margin-bottom: 8px;">⚠️</div>
      <h1 style="font-size: 1.35rem; margin: 0 0 12px; color:#ffb4b4;">${opts.title}</h1>
      <p style="font-size: 0.95rem; line-height: 1.55; color:#e6e8f0; margin: 0 0 14px;">${opts.message}</p>
      ${opts.hint ? `<p style="font-size:0.85rem; color:#9aa3bd; margin:0 0 14px;">${opts.hint}</p>` : ''}
      ${opts.technical ? `<details style="margin-top:10px; text-align:left;">
          <summary style="cursor:pointer; color:#7ea1ff; font-size:0.8rem;">Détails techniques</summary>
          <pre style="
            margin-top: 8px; padding: 10px; font-size: 11px;
            background: rgba(0,0,0,0.45); border-radius: 6px;
            color:#cfd6e8; white-space: pre-wrap; word-break: break-word;
          ">${opts.technical}</pre>
        </details>` : ''}
      <button id="err-close" style="
        margin-top: 18px; padding: 8px 18px;
        background: rgba(80,120,255,0.25); color:#fff;
        border: 1px solid rgba(120,160,255,0.55);
        border-radius: 999px; cursor: pointer; font-size: 0.9rem;
      ">Fermer l'onglet</button>
    </div>
  `;
  document.getElementById('err-close')?.addEventListener('click', () => window.close());
}

function explainWorkerError(raw: string): { title: string; message: string; hint?: string } {
  // laz-perf WASM throws unrecoverable C++ exceptions as "<addr> - Exception
  // catching is disabled". The address is just a heap pointer; the real
  // cause is almost always (a) corrupt LAZ payload, (b) WASM heap OOM on
  // memory-constrained devices, or (c) integrated-GPU machines where shared
  // RAM is already saturated.
  if (/Exception catching is disabled/i.test(raw) || /^\d{6,}\s*-\s*Exception/.test(raw)) {
    return {
      title: 'Décodage LAZ impossible',
      message:
        "Le décodeur LiDAR (laz-perf, WebAssembly) a levé une exception interne qu'il ne peut pas décrire. " +
        "C'est en général dû à une mémoire insuffisante pendant la décompression (les machines sans GPU dédié partagent leur RAM avec le processeur graphique) " +
        'ou à une tuile partiellement téléchargée.',
      hint:
        "Essayez de supprimer puis re-télécharger la tuile, fermez les autres onglets gourmands, " +
        "ou ouvrez le visualiseur sur une machine équipée d'une carte graphique dédiée.",
    };
  }
  return {
    title: 'Erreur de chargement',
    message: raw,
  };
}

// --- Main ---
let renderer: LidarRenderer | null = null;

// Engine switch button (bottom-right). One-way: WebGPU → WebGL.
// In WebGL mode it stays visible but disabled as an indicator.
const engineBtn = document.getElementById('engine-btn') as HTMLButtonElement | null;
const forceWebGL = params.get('engine') === 'webgl';
if (engineBtn) {
  if (forceWebGL) {
    engineBtn.textContent = '⚙ Moteur : WebGL HD';
    engineBtn.disabled = true;
    engineBtn.title = 'Moteur WebGL HD actif. Rechargez sans le paramètre ?engine=webgl pour revenir à WebGPU.';
  } else {
    engineBtn.addEventListener('click', () => {
      if (!confirm(
        'Basculer vers le moteur WebGL HD ?\n\n' +
        '• Terrain texturé orthophoto en haute résolution\n' +
        '• Pas de nuage de points LiDAR (compatible toutes machines)\n' +
        '• Action irréversible : il faudra recharger pour revenir à WebGPU.'
      )) return;
      const url = new URL(window.location.href);
      url.searchParams.set('engine', 'webgl');
      window.location.href = url.toString();
    });
  }
}

async function startWebGLFallback(reasonForLog: string): Promise<void> {
  console.warn(`[Viewer] Starting WebGL HD fallback — ${reasonForLog}`);
  setStatus('Bascule vers le moteur WebGL HD…', 4);
  const buffer = await loadFromOPFS();
  const { runWebGLFallback } = await import('../../lidar/viewer-webgl/main');
  await runWebGLFallback(
    { canvas, overlay, status: statusEl, bar: barFill, stats: statsEl },
    {
      buffer,
      altRefLabel: altRef,
      tileLabel: `${xKm},${yKm} ${crs}/${altRef}`,
      reloadBuffer: () => loadFromOPFS(),
    },
  );
}

(async () => {
  try {
    // User explicitly requested WebGL via the engine switch button → skip
    // the entire WebGPU pipeline and run the fallback directly.
    if (forceWebGL) {
      try {
        await startWebGLFallback('user requested ?engine=webgl');
        return;
      } catch (err: any) {
        console.error('[Viewer] Forced WebGL fallback failed:', err);
        showFatalError({
          title: 'Moteur WebGL HD indisponible',
          message: "Impossible de démarrer le moteur WebGL HD demandé.",
          hint: "Vérifiez que la tuile est bien téléchargée, mettez à jour vos pilotes graphiques, ou réessayez sans le paramètre ?engine=webgl.",
          technical: err?.message || String(err),
        });
        return;
      }
    }

    // 0. WebGPU preflight — bail early on machines without a usable GPU
    setStatus('Vérification du support WebGPU...', 2);
    const pre = await preflightWebGPU();
    if (!pre.ok) {
      // No usable WebGPU adapter → spin up the WebGL2 fallback engine
      // (textured terrain only, no point cloud). Works on iGPU / older
      // browsers / headless setups.
      try {
        await startWebGLFallback(`preflight=${pre.code}`);
        return;
      } catch (fallbackErr: any) {
        console.error('[Viewer] WebGL fallback failed:', fallbackErr);
        const detail = fallbackErr?.message || String(fallbackErr);
        showFatalError({
          title: 'Aucun moteur compatible',
          message:
            "Ni WebGPU ni le moteur WebGL HD de secours n'ont pu démarrer sur cette machine. " +
            "Le visualiseur LiDAR HD ne peut pas s'afficher.",
          hint:
            "Mettez à jour vos pilotes graphiques, utilisez un navigateur récent (Chrome / Edge / Firefox), " +
            "ou ouvrez le visualiseur sur une machine équipée d'un GPU dédié.",
          technical: `WebGPU: ${pre.code} — ${pre.detail}\nWebGL fallback: ${detail}`,
        });
        return;
      }
    }
    console.log(`[Viewer] Preflight OK — vendor=${pre.vendor} arch=${pre.arch} desc=${pre.desc}`);

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
      if (e.key === 'n' || e.key === 'N') void cycleSnow();
    });

    // ---------------- SNOW ❄ ----------------
    // Bouton bas de l'écran : off → cover → thickness → off
    // Au premier passage non-off, fetch AROME via Open-Meteo + redistribution.
    const snowBtn = document.getElementById('snow-btn') as HTMLButtonElement | null;
    const snowModes: Array<{ key: 'off' | 'cover' | 'thickness'; gpu: 0 | 1 | 2; label: string }> = [
      { key: 'off',       gpu: 0, label: '❄ Neige : off' },
      { key: 'cover',     gpu: 1, label: '❄ Couverture' },
      { key: 'thickness', gpu: 2, label: '❄ Épaisseur (cm)' },
    ];
    let snowIdx = 0;
    let snowFieldLoaded = false;
    let snowLoading = false;

    async function cycleSnow() {
      if (!renderer || !snowBtn || snowLoading) return;
      const pc = pointCloud;
      const tm = terrainMesh;
      if (!pc || !tm) return;
      const next = (snowIdx + 1) % snowModes.length;
      const mode = snowModes[next];
      // Premier passage en mode != off → on calcule le champ de neige
      if (!snowFieldLoaded && mode.gpu !== 0) {
        snowLoading = true;
        snowBtn.classList.add('loading');
        snowBtn.textContent = '❄ Calcul…';
        try {
          const { runSnowPipeline } = await import('../../snow');
          const field = await runSnowPipeline(
            {
              data: tm.heightGrid,
              width: tm.gridWidth,
              height: tm.gridHeight,
              bounds: pc.bounds,
              crs,
            },
            {
              progress: (pct, label) => {
                snowBtn.textContent = `❄ ${label} ${pct.toFixed(0)}%`;
              },
            },
          );
          // Le champ de neige est row-major SUD→NORD ; le renderer attend
          // l'orientation heightmap (NORD→SUD). On flip les lignes.
          const flipped = new Float32Array(field.data.length);
          for (let y = 0; y < field.height; y++) {
            const srcRow = (field.height - 1 - y) * field.width;
            const dstRow = y * field.width;
            for (let x = 0; x < field.width; x++) {
              flipped[dstRow + x] = field.data[srcRow + x];
            }
          }
          renderer.setSnow({
            data: flipped,
            width: field.width,
            height: field.height,
            originX: pc.bounds.minX - cx,
            originZ: -(pc.bounds.maxY - cy),
            scaleX: pc.bounds.maxX - pc.bounds.minX,
            scaleZ: pc.bounds.maxY - pc.bounds.minY,
          });
          snowFieldLoaded = true;
          console.log(
            `[Viewer] Snow loaded: avg=${field.stats.meanCm.toFixed(0)}cm, ` +
            `max=${field.stats.maxCm.toFixed(0)}cm, cov=${field.stats.coveragePct.toFixed(1)}%, ` +
            `${field.stats.elapsedMs.toFixed(0)}ms (AROME ${field.arome.timestamp})`,
          );
        } catch (err) {
          console.error('[Viewer] Snow fetch failed:', err);
          snowBtn.textContent = '❄ Erreur';
          setTimeout(() => { if (snowBtn) snowBtn.textContent = snowModes[0].label; }, 2500);
          snowIdx = 0;
          renderer.setSnowMode(0);
          return;
        } finally {
          snowLoading = false;
          snowBtn.classList.remove('loading');
        }
      }
      snowIdx = next;
      renderer.setSnowMode(mode.gpu);
      snowBtn.textContent = mode.label;
      snowBtn.classList.toggle('active', mode.gpu !== 0);
    }
    snowBtn?.addEventListener('click', () => void cycleSnow());

  } catch (err: any) {
    const raw = err?.message || String(err);
    console.error('[Viewer] Fatal:', err);
    const explained = explainWorkerError(raw);
    showFatalError({ ...explained, technical: raw });
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
